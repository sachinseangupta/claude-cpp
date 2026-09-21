// Runs inside the VS Code extension host.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for: ' + what);
    await sleep(150);
  }
}

exports.run = async function run() {
  const root = process.env.CLAUDE_CPP_WORKSPACE;
  const dir = path.join(root, '.claude-cpp');
  const source = path.join(dir, 'instructions.cpp');
  const step = (m) => console.log('  •', m);

  step('workspace folder is open');
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  const ext = vscode.extensions.getExtension('sachingupta.claude-cpp');
  assert.ok(ext, 'extension not found');
  await ext.activate();

  step('auto-open: scaffold created, instructions.cpp shown, webview panel opened beside it');
  await until('scaffold', () => fs.existsSync(source) && fs.existsSync(path.join(dir, 'claude.hpp')));
  await until('instructions.cpp active in editor', () => vscode.window.activeTextEditor?.document.uri.fsPath === source);
  const webviewTab = await until('webview tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input && t.input.viewType && t.input.viewType.includes('claudeCpp')));
  const groups = vscode.window.tabGroups.all;
  assert.ok(groups.length >= 2, 'panel should be in a second column');
  assert.equal(webviewTab.label, 'Claude · C++');

  step('initial compile ran (binary exists)');
  await until('binary', () => fs.existsSync(path.join(dir, 'build', 'instructions')));

  step('a compile error produces squiggles on the right line; fixing it clears them');
  const uri = vscode.Uri.file(source);
  const doc = await vscode.workspace.openTextDocument(uri);
  const original = doc.getText();
  const broken = original.replace('p.goal(', 'p.goall(');
  assert.notEqual(broken, original);
  let edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), broken);
  await vscode.workspace.applyEdit(edit);
  await doc.save(); // compile-on-save fires
  const diags = await until('diagnostics', () => {
    const d = vscode.languages.getDiagnostics(uri).filter((x) => x.severity === vscode.DiagnosticSeverity.Error);
    return d.length ? d : null;
  });
  const badLine = broken.split('\n').findIndex((l) => l.includes('goall'));
  assert.equal(diags[0].range.start.line, badLine, 'squiggle should be on the broken line');
  assert.equal(diags[0].source, 'claude-cpp');

  edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), original);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
  await until('diagnostics cleared', () => vscode.languages.getDiagnostics(uri).filter((x) => x.severity === vscode.DiagnosticSeverity.Error).length === 0);

  step('Send: compiles, then invokes the Claude CLI with the compiled prompt on stdin (fake CLI)');
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const captured = path.join(fakeDir, 'captured.txt');
  const fake = path.join(fakeDir, 'claude');
  fs.writeFileSync(fake, `#!/bin/bash
echo "$*" > "${captured}.args"
cat > "${captured}"
printf '{"type":"system","subtype":"init","session_id":"sess-A"}\\n{"type":"result","is_error":false,"result":"ok","session_id":"sess-A","total_cost_usd":0,"duration_ms":1,"permission_denials":[]}\\n'
`, { mode: 0o755 });
  const cfg = vscode.workspace.getConfiguration('claudeCpp');
  await cfg.update('claudePath', fake, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('claudeCpp.send');
  await until('fake claude received prompt', () => fs.existsSync(captured) && fs.readFileSync(captured, 'utf8').length > 0);
  const sent = fs.readFileSync(captured, 'utf8');
  assert.match(sent, /^# Goal\nExplain what this project does/);
  assert.match(fs.readFileSync(captured + '.args', 'utf8'), /--permission-mode acceptEdits/);
  assert.doesNotMatch(fs.readFileSync(captured + '.args', 'utf8'), /--resume/);

  step('a second Send continues the same session (--resume)');
  await sleep(500);
  fs.rmSync(captured + '.args');
  await vscode.commands.executeCommand('claudeCpp.send');
  await until('resume args', () => fs.existsSync(captured + '.args'));
  assert.match(fs.readFileSync(captured + '.args', 'utf8'), /--resume sess-A/);

  step('New Conversation forgets the session');
  await sleep(500);
  await vscode.commands.executeCommand('claudeCpp.newSession');
  fs.rmSync(captured + '.args');
  await vscode.commands.executeCommand('claudeCpp.send');
  await until('fresh args', () => fs.existsSync(captured + '.args'));
  assert.doesNotMatch(fs.readFileSync(captured + '.args', 'utf8'), /--resume/);

  step('Send is refused (and nothing is sent) when the code does not compile');
  await sleep(500);
  fs.rmSync(captured);
  edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), 'int main( {');
  await vscode.workspace.applyEdit(edit);
  await vscode.commands.executeCommand('claudeCpp.send');
  await sleep(2500);
  assert.ok(!fs.existsSync(captured), 'nothing should have been sent');

  step('reset header command restores the bundled header');
  fs.writeFileSync(path.join(dir, 'claude.hpp'), '// broken');
  await vscode.commands.executeCommand('claudeCpp.resetHeader');
  assert.match(fs.readFileSync(path.join(dir, 'claude.hpp'), 'utf8'), /CLAUDE_CPP_HEADER_VERSION/);

  await cfg.update('claudePath', undefined, vscode.ConfigurationTarget.Global);
};
