import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildAndRun, BuildResult } from './compiler';
import { ClaudeEvent, resolveClaudeBinary, runClaude } from './claude';
import { ensureScaffold, resetHeader, Scaffold, WORK_DIR } from './scaffold';
import { ClaudePanel } from './panel';

export type Status = 'idle' | 'compiling' | 'ok' | 'error' | 'untrusted';

export interface UiState {
  status: Status;
  message: string;
  prompt: string;
  runOutput: string;
  compilerOutput: string;
  busy: boolean;
  hasSession: boolean;
  sourceLabel: string;
}

export type ChatEntry = { role: 'you'; text: string } | { role: 'claude'; event: ClaudeEvent };

export class Controller implements vscode.Disposable {
  private scaffold?: Scaffold;
  private panel?: ClaudePanel;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('claude-cpp');
  private compileAbort?: AbortController;
  private claudeAbort?: AbortController;
  private compileSeq = 0;
  private sessionId?: string;
  private busy = false;
  private chat: ChatEntry[] = [];
  private state: UiState = {
    status: 'idle',
    message: '',
    prompt: '',
    runOutput: '',
    compilerOutput: '',
    busy: false,
    hasSession: false,
    sourceLabel: `${WORK_DIR}/instructions.cpp`,
  };
  private last?: BuildResult;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this.compileAbort?.abort();
    this.claudeAbort?.abort();
    this.diagnostics.dispose();
    this.panel?.dispose();
  }

  private get config() {
    return vscode.workspace.getConfiguration('claudeCpp');
  }

  private get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  isInstructionsFile(uri: vscode.Uri): boolean {
    return !!this.scaffold && path.resolve(uri.fsPath) === path.resolve(this.scaffold.source);
  }

  // --- opening -------------------------------------------------------------

  /** Create the scaffold, show instructions.cpp on the left and the panel beside it. */
  async open(opts: { focusEditor: boolean } = { focusEditor: true }): Promise<void> {
    const root = this.root;
    if (!root) {
      void vscode.window.showInformationMessage('Claude C++: open a folder first.');
      return;
    }
    try {
      this.scaffold = ensureScaffold(root, this.context.extensionPath);
    } catch (e) {
      void vscode.window.showErrorMessage(`Claude C++: could not create ${WORK_DIR}/: ${(e as Error).message}`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(this.scaffold.source);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: !opts.focusEditor });

    if (!this.panel) {
      this.panel = new ClaudePanel(this.context, {
        onReady: () => this.pushAll(),
        onCompile: () => void this.compile(),
        onSend: () => void this.send(),
        onStop: () => this.stop(),
        onNewSession: () => this.newSession(),
        onOpenSource: () => void this.showFile(this.scaffold!.source),
        onOpenHeader: () => void this.showFile(this.scaffold!.header),
        onDispose: () => (this.panel = undefined),
      });
    } else {
      this.panel.reveal();
    }
    await this.compile();
  }

  private async showFile(file: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  }

  resetHeader(): void {
    const root = this.root;
    if (!root) return;
    const target = resetHeader(root, this.context.extensionPath);
    void vscode.window.showInformationMessage(`Restored ${path.relative(root, target)} to the bundled version.`);
    void this.compile();
  }

  // --- compiling -----------------------------------------------------------

  async compile(): Promise<BuildResult | undefined> {
    const root = this.root;
    if (!root) return;
    if (!this.scaffold) this.scaffold = ensureScaffold(root, this.context.extensionPath);

    if (!vscode.workspace.isTrusted) {
      this.set({
        status: 'untrusted',
        message: 'This workspace is not trusted. Compiling runs your C++ program, so it is disabled until you trust the folder.',
        prompt: '',
        runOutput: '',
        compilerOutput: '',
      });
      return;
    }

    this.compileAbort?.abort();
    const abort = (this.compileAbort = new AbortController());
    const seq = ++this.compileSeq;
    this.set({ status: 'compiling', message: 'Compiling…' });

    // Save the file first so we build what the user sees.
    const open = vscode.workspace.textDocuments.find((d) => this.isInstructionsFile(d.uri));
    if (open?.isDirty) await open.save();

    const cfg = this.config;
    const result = await buildAndRun({
      compiler: cfg.get<string>('compiler', 'clang++'),
      standard: cfg.get<string>('cppStandard', 'c++20'),
      extraFlags: cfg.get<string[]>('extraCompilerFlags', []),
      source: this.scaffold.source,
      buildDir: this.scaffold.buildDir,
      cwd: root,
      signal: abort.signal,
    });
    if (seq !== this.compileSeq || result.aborted) return; // a newer compile superseded this one

    this.last = result;
    this.publishDiagnostics(result);
    this.set({
      status: result.ok ? 'ok' : 'error',
      message: result.ok ? `Compiled in ${(result.durationMs / 1000).toFixed(1)}s` : result.message,
      prompt: result.prompt,
      runOutput: result.runOutput,
      compilerOutput: result.compilerOutput,
    });
    return result;
  }

  private publishDiagnostics(result: BuildResult): void {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of result.diagnostics) {
      if (d.severity === 'note') continue;
      const line = Math.max(0, d.line - 1);
      const col = Math.max(0, d.column - 1);
      const diag = new vscode.Diagnostic(
        new vscode.Range(line, col, line, col),
        d.message,
        d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      diag.source = 'claude-cpp';
      const key = path.resolve(this.scaffold?.dir ?? '', d.file);
      byFile.set(key, [...(byFile.get(key) ?? []), diag]);
    }
    for (const [file, diags] of byFile) this.diagnostics.set(vscode.Uri.file(file), diags);
  }

  // --- talking to Claude ---------------------------------------------------

  async send(): Promise<void> {
    if (this.busy) return;
    if (!this.panel) await this.open();
    const built = await this.compile();
    if (!built?.ok) {
      if (built) void vscode.window.showWarningMessage('Claude C++: fix the compile errors before sending.');
      return;
    }
    const root = this.root!;
    const cfg = this.config;
    const binary = await resolveClaudeBinary(cfg.get<string>('claudePath', ''));
    if (!binary) {
      this.addChat({ role: 'claude', event: { kind: 'error', message: 'Claude Code CLI not found. Install it, or set claudeCpp.claudePath.' } });
      return;
    }

    this.addChat({ role: 'you', text: built.prompt });
    this.busy = true;
    this.set({ busy: true });
    const abort = (this.claudeAbort = new AbortController());
    try {
      await runClaude({
        binary,
        prompt: built.prompt,
        cwd: root,
        sessionId: this.sessionId,
        permissionMode: cfg.get<string>('permissionMode', 'acceptEdits'),
        allowedTools: cfg.get<string[]>('allowedTools', []),
        model: cfg.get<string>('model', '') || undefined,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.kind === 'init') this.sessionId = event.sessionId;
          if (event.kind === 'result' && event.sessionId) this.sessionId = event.sessionId;
          this.addChat({ role: 'claude', event });
        },
      });
    } finally {
      this.busy = false;
      this.claudeAbort = undefined;
      this.set({ busy: false, hasSession: !!this.sessionId });
    }
  }

  stop(): void {
    this.claudeAbort?.abort();
  }

  newSession(): void {
    if (this.busy) return;
    this.sessionId = undefined;
    this.chat = [];
    this.set({ hasSession: false });
    this.panel?.post({ type: 'chat-reset' });
  }

  // --- state plumbing ------------------------------------------------------

  private addChat(entry: ChatEntry): void {
    this.chat.push(entry);
    this.panel?.post({ type: 'chat', entry });
  }

  private set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    this.panel?.post({ type: 'state', state: this.state });
  }

  private pushAll(): void {
    this.panel?.post({ type: 'chat-reset' });
    for (const entry of this.chat) this.panel?.post({ type: 'chat', entry });
    this.panel?.post({ type: 'state', state: this.state }); // last, so the "working" indicator survives the reset
  }
}
