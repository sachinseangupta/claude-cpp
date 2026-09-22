import * as vscode from 'vscode';
import { isLanguage, Language } from './language';

export interface PanelHandlers {
  onReady(): void;
  onCompile(): void;
  onSend(): void;
  onStop(): void;
  onNewSession(): void;
  onSetLanguage(language: Language): void;
  onOpenSource(): void;
  onOpenVocabulary(): void;
  onDispose(): void;
}

export class ClaudePanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;

  constructor(context: vscode.ExtensionContext, handlers: PanelHandlers) {
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'claudeCpp',
      'Claude · C++',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.svg');
    this.panel.webview.html = this.html(mediaRoot);

    this.panel.webview.onDidReceiveMessage((m: { type: string; language?: unknown }) => {
      switch (m.type) {
        case 'ready': return handlers.onReady();
        case 'compile': return handlers.onCompile();
        case 'send': return handlers.onSend();
        case 'stop': return handlers.onStop();
        case 'new-session': return handlers.onNewSession();
        case 'set-language': return isLanguage(m.language) ? handlers.onSetLanguage(m.language) : undefined;
        case 'open-source': return handlers.onOpenSource();
        case 'open-vocabulary': return handlers.onOpenVocabulary();
      }
    });
    this.panel.onDidDispose(() => handlers.onDispose());
  }

  post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private html(mediaRoot: vscode.Uri): string {
    const web = this.panel.webview;
    const uri = (f: string) => web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, f));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('panel.css')}">
  <title>Claude · C++</title>
</head>
<body>
  <div id="app">
    <header class="bar">
      <span class="title">Claude</span>
      <div class="seg" role="group" aria-label="Language your instructions are written in">
        <button id="lang-cpp" data-language="cpp" aria-pressed="true" title="Write instructions in C++">C++</button>
        <button id="lang-python" data-language="python" aria-pressed="false" title="Write instructions in Python">Python</button>
      </div>
      <span id="status" class="badge" data-status="idle">…</span>
      <span class="spacer"></span>
      <button id="btn-source" class="ghost" title="Open instructions.cpp">instructions.cpp</button>
      <button id="btn-vocabulary" class="ghost" title="Open claude.hpp">claude.hpp</button>
      <button id="btn-compile" class="ghost" title="Compile and run instructions.cpp">Compile</button>
      <button id="btn-new" class="ghost" title="Forget the conversation and start fresh">New conversation</button>
    </header>

    <section id="compiled">
      <div class="label">Compiled prompt <span id="compile-msg" class="dim"></span></div>
      <pre id="compiler-output" class="block err" hidden></pre>
      <pre id="run-output" class="block warn" hidden></pre>
      <pre id="preview" class="block preview"></pre>
      <div class="send-row">
        <button id="btn-send" class="primary" disabled>Send to Claude</button>
        <button id="btn-stop" class="secondary" hidden>Stop</button>
        <span id="session" class="dim"></span>
      </div>
    </section>

    <section id="chat" aria-live="polite">
      <div id="empty" class="dim">Write your instructions in C++, save, then send. Claude's replies appear here.</div>
    </section>
  </div>
  <script nonce="${nonce}" src="${uri('panel.js')}"></script>
</body>
</html>`;
  }
}
