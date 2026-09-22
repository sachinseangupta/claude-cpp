import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildAndRun, BuildResult } from './compiler';
import { ClaudeEvent, resolveClaudeBinary, runClaude } from './claude';
import { DEFAULT_LANGUAGE, isLanguage, Language, LANGUAGES } from './language';
import { ensureScaffold, resetVocabulary, Scaffold, WORK_DIR } from './scaffold';
import { ClaudePanel } from './panel';

const LANGUAGE_KEY = 'claudeCpp.language';

export type Status = 'idle' | 'compiling' | 'ok' | 'error' | 'untrusted';

export interface UiState {
  status: Status;
  message: string;
  prompt: string;
  runOutput: string;
  compilerOutput: string;
  busy: boolean;
  hasSession: boolean;
  language: Language;
  sourceName: string; // e.g. instructions.py
  vocabularyName: string; // e.g. claude.py
}

export type ChatEntry = { role: 'you'; text: string; language: Language } | { role: 'claude'; event: ClaudeEvent };

function languageState(language: Language): Pick<UiState, 'language' | 'sourceName' | 'vocabularyName'> {
  const info = LANGUAGES[language];
  return { language, sourceName: info.source, vocabularyName: info.vocabulary };
}

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
  private language: Language;
  private state: UiState;
  private last?: BuildResult;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<string>(LANGUAGE_KEY);
    this.language = isLanguage(saved) ? saved : DEFAULT_LANGUAGE;
    this.state = {
      status: 'idle',
      message: '',
      prompt: '',
      runOutput: '',
      compilerOutput: '',
      busy: false,
      hasSession: false,
      ...languageState(this.language),
    };
  }

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

  /**
   * The active language's instructions file or a module it pulls in (claude.hpp / project.hpp, claude.py / project.py):
   * saving any of them should rebuild. The other language's files are ignored -- they are not what is showing.
   */
  isPromptSource(uri: vscode.Uri): boolean {
    if (!this.scaffold) return false;
    const file = path.resolve(uri.fsPath);
    return this.isInstructionsFile(uri) || (path.dirname(file) === path.resolve(this.scaffold.dir) && file.endsWith(LANGUAGES[this.language].moduleExt));
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
      this.scaffold = ensureScaffold(root, this.context.extensionPath, this.language);
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
        onSetLanguage: (language) => void this.setLanguage(language),
        onOpenSource: () => void this.showFile(this.scaffold!.source),
        onOpenVocabulary: () => void this.showFile(this.scaffold!.vocabulary),
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

  resetVocabulary(): void {
    const root = this.root;
    if (!root) return;
    const target = resetVocabulary(root, this.context.extensionPath, this.language);
    void vscode.window.showInformationMessage(`Restored ${path.relative(root, target)} to the bundled version.`);
    void this.compile();
  }

  // --- language ------------------------------------------------------------

  get currentLanguage(): Language {
    return this.language;
  }

  /**
   * Switch between writing instructions in C++ and in Python. Both sets of files live in .claude-cpp/;
   * the first switch to a language creates its starter files. The Claude conversation carries over --
   * it is about the work, not about how the message was written.
   */
  async setLanguage(language: Language): Promise<void> {
    if (language === this.language && this.scaffold) return;
    if (!this.root) {
      void vscode.window.showInformationMessage('Claude C++: open a folder first.');
      return;
    }
    this.compileAbort?.abort(); // a build of the old language must not publish over the new one
    this.compileSeq++;
    this.language = language;
    this.scaffold = undefined;
    await this.context.workspaceState.update(LANGUAGE_KEY, language);
    // Drop the other language's result so it cannot be sent while this one builds.
    this.set({ ...languageState(language), status: 'idle', message: '', prompt: '', runOutput: '', compilerOutput: '' });
    this.diagnostics.clear();
    await this.open({ focusEditor: true });
  }

  /** Command-palette entry: pick a language (or pass one). */
  async pickLanguage(language?: unknown): Promise<void> {
    if (isLanguage(language)) return this.setLanguage(language);
    const picked = await vscode.window.showQuickPick(
      Object.values(LANGUAGES).map((l) => ({ label: l.label, description: l.id === this.language ? 'current' : l.source, id: l.id })),
      { placeHolder: 'Write your instructions in…' },
    );
    if (picked) await this.setLanguage(picked.id);
  }

  // --- compiling -----------------------------------------------------------

  async compile(): Promise<BuildResult | undefined> {
    const root = this.root;
    if (!root) return;
    if (!this.scaffold) this.scaffold = ensureScaffold(root, this.context.extensionPath, this.language);
    const scaffold = this.scaffold;
    const info = LANGUAGES[scaffold.language];

    if (!vscode.workspace.isTrusted) {
      this.set({
        status: 'untrusted',
        message: `This workspace is not trusted. ${info.source} is a program that gets run, so that is disabled until you trust the folder.`,
        prompt: '',
        runOutput: '',
        compilerOutput: '',
      });
      return;
    }

    this.compileAbort?.abort();
    const abort = (this.compileAbort = new AbortController());
    const seq = ++this.compileSeq;
    this.set({ status: 'compiling', message: info.progress });

    // Save the file first so we build what the user sees.
    const open = vscode.workspace.textDocuments.find((d) => this.isInstructionsFile(d.uri));
    if (open?.isDirty) await open.save();

    const cfg = this.config;
    const common = { source: scaffold.source, cwd: root, signal: abort.signal };
    const result = await buildAndRun(
      scaffold.language === 'python'
        ? { ...common, language: 'python', python: cfg.get<string>('python', 'python3') || 'python3' }
        : {
            ...common,
            compiler: cfg.get<string>('compiler', 'clang++'),
            standard: cfg.get<string>('cppStandard', 'c++20'),
            extraFlags: cfg.get<string[]>('extraCompilerFlags', []),
            buildDir: scaffold.buildDir,
          },
    );
    if (seq !== this.compileSeq || result.aborted) return; // a newer compile superseded this one

    this.last = result;
    this.publishDiagnostics(result);
    this.set({
      status: result.ok ? 'ok' : 'error',
      message: result.ok ? `${info.done} in ${(result.durationMs / 1000).toFixed(1)}s` : result.message,
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
    const language = this.language; // switching languages mid-build voids this send (compile() returns undefined)
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

    this.addChat({ role: 'you', text: built.prompt, language });
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
