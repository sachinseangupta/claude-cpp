// Tests for the vscode-independent core. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAndRun, parseDiagnostics } = require('../out/compiler');
const { parseStreamLine, runClaude } = require('../out/claude');
const { ensureScaffold, resetHeader } = require('../out/scaffold');

const ROOT = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cpp-test-'));

/** Set up a project dir with the header and the given instructions.cpp text. */
function project(source) {
  const root = tmp();
  const dir = path.join(root, '.claude-cpp');
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ROOT, 'include', 'claude.hpp'), path.join(dir, 'claude.hpp'));
  fs.writeFileSync(path.join(dir, 'instructions.cpp'), source);
  return { root, source: path.join(dir, 'instructions.cpp'), buildDir: path.join(dir, 'build') };
}
const build = (p, extra = {}) =>
  buildAndRun({ compiler: 'clang++', standard: 'c++20', extraFlags: [], source: p.source, buildDir: p.buildDir, cwd: p.root, ...extra });

// ---------------------------------------------------------------- compiler
test('the starter template compiles and produces a prompt, with warnings for missing paths', async () => {
  const p = project(fs.readFileSync(path.join(ROOT, 'templates', 'instructions.cpp'), 'utf8'));
  const r = await build(p);
  assert.equal(r.ok, true, r.message + r.compilerOutput);
  assert.match(r.prompt, /^# Goal\n/);
  assert.match(r.prompt, /1\. Read the README/);
  assert.match(r.runOutput, /warning: File not found: README\.md/);
  assert.match(r.runOutput, /warning: Directory not found: src/);
});

test('existing files and functions raise no warnings; loops generate steps', async () => {
  const p = project(`#include "claude.hpp"
using namespace claude;
int main() {
  Prompt p;
  p.goal("g");
  p.context({File("a.txt"), Function("hello", "a.txt")});
  for (int i = 1; i <= 3; ++i) p.step("step " + std::to_string(i) + "\\nmore detail");
  return p.emit();
}`);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'void hello();');
  const r = await build(p);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.runOutput, '');
  assert.match(r.prompt, /- Function `hello` in `a\.txt`/);
  assert.match(r.prompt, /3\. step 3\n {3}more detail/);
});

test('a function missing from its file is flagged', async () => {
  const p = project(`#include "claude.hpp"
int main() { claude::Prompt p; p.goal("g"); p.context(claude::Function("nope", "a.txt")); return p.emit(); }`);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'void hello();');
  const r = await build(p);
  assert.equal(r.ok, true);
  assert.match(r.runOutput, /'nope' does not appear in a\.txt/);
});

test('compile errors are reported with line/column and nothing is run', async () => {
  const p = project(`#include "claude.hpp"
int main() {
  claude::Prompt p;
  int x = "not an int";
  return p.emit();
}`);
  const r = await build(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'compile');
  assert.match(r.message, /1 error/);
  const err = r.diagnostics.find((d) => d.severity === 'error');
  assert.ok(err, r.compilerOutput);
  assert.equal(err.line, 4);
  assert.ok(err.column > 0);
  assert.equal(r.prompt, '');
});

test('a stale binary from a previous good build is not run after a failed compile', async () => {
  const p = project(`#include "claude.hpp"
int main() { claude::Prompt p; p.goal("first"); return p.emit(); }`);
  assert.equal((await build(p)).ok, true);
  fs.writeFileSync(p.source, 'int main( { }');
  const r = await build(p);
  assert.equal(r.ok, false);
  assert.equal(r.prompt, '');
});

test('a prompt without a goal fails at run time with a helpful message', async () => {
  const p = project(`#include "claude.hpp"
int main() { claude::Prompt p; return p.emit(); }`);
  const r = await build(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'run');
  assert.match(r.message, /exited with code 1/);
  assert.match(r.runOutput, /no goal/);
});

test('a program that prints nothing is not sendable', async () => {
  const p = project('int main() { return 0; }');
  const r = await build(p);
  assert.equal(r.ok, false);
  assert.match(r.message, /printed nothing/);
});

test('an infinite loop is stopped by the run timeout', async () => {
  const p = project('int main() { volatile int i = 0; while (true) { i = i + 1; } }');
  const r = await build(p, { runTimeoutMs: 400 });
  assert.equal(r.ok, false);
  assert.match(r.message, /longer than 0.4 seconds/);
});

test('a missing compiler gives an actionable message', async () => {
  const p = project('int main() {}');
  const r = await build(p, { compiler: 'definitely-not-a-compiler' });
  assert.equal(r.ok, false);
  assert.match(r.message, /was not found/);
});

test('aborting cancels the build', async () => {
  const p = project('int main() {}');
  const ac = new AbortController();
  const pending = build(p, { signal: ac.signal });
  ac.abort();
  const r = await pending;
  assert.equal(r.aborted, true);
});

test('the program runs from the project root so relative paths resolve', async () => {
  const p = project(`#include "claude.hpp"
int main() { claude::Prompt p; p.goal("g"); p.context(claude::File("marker.txt")); return p.emit(); }`);
  fs.writeFileSync(path.join(p.root, 'marker.txt'), 'x');
  const r = await build(p);
  assert.equal(r.runOutput, '');
});

test('parseDiagnostics understands clang output', () => {
  const d = parseDiagnostics('/a/b.cpp:12:5: error: use of undeclared identifier \'x\'\n  x = 1;\n  ^\n/a/b.cpp:3:1: warning: unused\n/a/b.cpp:3:1: note: here\nfatal error: none');
  assert.deepEqual(d.map((x) => [x.line, x.column, x.severity]), [[12, 5, 'error'], [3, 1, 'warning'], [3, 1, 'note']]);
});

// ---------------------------------------------------------------- scaffold
test('scaffold creates the files once and never overwrites user edits', () => {
  const root = tmp();
  const s = ensureScaffold(root, ROOT);
  assert.ok(s.createdSource);
  for (const f of [s.source, s.header, path.join(s.dir, '.gitignore'), path.join(s.dir, 'compile_flags.txt')]) assert.ok(fs.existsSync(f), f);
  fs.writeFileSync(s.source, '// mine');
  fs.writeFileSync(s.header, '// my header');
  const again = ensureScaffold(root, ROOT);
  assert.equal(again.createdSource, false);
  assert.equal(fs.readFileSync(s.source, 'utf8'), '// mine');
  assert.equal(fs.readFileSync(s.header, 'utf8'), '// my header');
  resetHeader(root, ROOT);
  assert.match(fs.readFileSync(s.header, 'utf8'), /CLAUDE_CPP_HEADER_VERSION/);
});

// ---------------------------------------------------------------- claude stream parsing
test('parseStreamLine maps the CLI stream to UI events', () => {
  assert.deepEqual(parseStreamLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}'), [{ kind: 'init', sessionId: 's1', model: 'm' }]);
  assert.deepEqual(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Edit","input":{"file_path":"/x/y.cpp"}}]}}'), [
    { kind: 'text', text: 'hi' },
    { kind: 'tool', name: 'Edit', summary: '/x/y.cpp' },
  ]);
  assert.deepEqual(parseStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"denied"}]}}'), [{ kind: 'tool-error', text: 'denied' }]);
  assert.deepEqual(parseStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","content":"fine"}]}}'), []);
  const [res] = parseStreamLine('{"type":"result","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.5,"duration_ms":1200,"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"ls"}}]}');
  assert.deepEqual(res, { kind: 'result', ok: true, text: 'ok', sessionId: 's1', costUsd: 0.5, durationMs: 1200, denied: [{ tool: 'Bash', summary: 'ls' }] });
  assert.deepEqual(parseStreamLine('not json'), []);
});

// ---------------------------------------------------------------- claude runner (fake CLI)
function fakeClaude(script) {
  const file = path.join(tmp(), 'claude');
  fs.writeFileSync(file, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return file;
}

test('runClaude sends the prompt on stdin, passes flags, and streams events', async () => {
  const bin = fakeClaude(`
echo "ARGS: $*" >&2
PROMPT=$(cat)
printf '{"type":"system","subtype":"init","session_id":"sess-1"}\\n'
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"got: %s"}]}}\\n' "$PROMPT"
printf '{"type":"result","is_error":false,"result":"done","session_id":"sess-1","total_cost_usd":0.01,"duration_ms":5,"permission_denials":[]}\\n'`);
  const events = [];
  await runClaude({ binary: bin, prompt: 'hello there', cwd: tmp(), sessionId: 'prev-9', permissionMode: 'acceptEdits', allowedTools: ['Bash(git status)'], model: 'sonnet', onEvent: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.kind), ['init', 'text', 'result']);
  assert.equal(events[1].text, 'got: hello there');
  assert.equal(events[2].sessionId, 'sess-1');
});

test('runClaude passes resume / permission / tool flags', async () => {
  const bin = fakeClaude(`printf '{"type":"result","is_error":false,"result":"%s","session_id":"s"}\\n' "$*"`);
  const events = [];
  await runClaude({ binary: bin, prompt: 'x', cwd: tmp(), sessionId: 'abc', permissionMode: 'plan', allowedTools: ['Read', 'Bash(ls)'], model: 'opus', onEvent: (e) => events.push(e) });
  const args = events[0].text;
  assert.match(args, /-p --output-format stream-json --verbose --permission-mode plan/);
  assert.match(args, /--model opus/);
  assert.match(args, /--resume abc/);
  assert.match(args, /--allowedTools=Read,Bash\(ls\)/);
});

test('runClaude reports a crash before any result', async () => {
  const bin = fakeClaude('cat >/dev/null; echo boom >&2; exit 3');
  const events = [];
  await runClaude({ binary: bin, prompt: 'x', cwd: tmp(), permissionMode: 'default', allowedTools: [], onEvent: (e) => events.push(e) });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'error');
  assert.match(events[0].message, /code 3[\s\S]*boom/);
});

test('runClaude reports a missing binary', async () => {
  const events = [];
  await runClaude({ binary: '/nonexistent/claude', prompt: 'x', cwd: tmp(), permissionMode: 'default', allowedTools: [], onEvent: (e) => events.push(e) });
  assert.equal(events.length, 1);
  assert.match(events[0].message, /not found/);
});

test('runClaude can be stopped', async () => {
  const bin = fakeClaude('cat >/dev/null; sleep 30');
  const ac = new AbortController();
  const events = [];
  const done = runClaude({ binary: bin, prompt: 'x', cwd: tmp(), permissionMode: 'default', allowedTools: [], signal: ac.signal, onEvent: (e) => events.push(e) });
  setTimeout(() => ac.abort(), 200);
  await done;
  assert.deepEqual(events.map((e) => e.message), ['Stopped.']);
});

// ---------------------------------------------------------------- live (opt-in: costs a few cents)
test('LIVE: the real Claude Code CLI answers a compiled prompt', { skip: !process.env.CLAUDE_CPP_LIVE }, async () => {
  const { resolveClaudeBinary } = require('../out/claude');
  const binary = await resolveClaudeBinary('');
  assert.ok(binary, 'claude CLI not found');
  const p = project(`#include "claude.hpp"
int main() { claude::Prompt p; p.goal("Reply with exactly the single word: pong"); p.constrain("Do not use any tools."); return p.emit(); }`);
  const built = await build(p);
  assert.equal(built.ok, true);
  const events = [];
  await runClaude({ binary, prompt: built.prompt, cwd: p.root, permissionMode: 'default', allowedTools: [], onEvent: (e) => events.push(e) });
  const result = events.find((e) => e.kind === 'result');
  assert.ok(result?.ok, JSON.stringify(events));
  assert.match(result.text.toLowerCase(), /pong/);
  // follow-up resumes the same session
  const followUp = [];
  await runClaude({ binary, prompt: 'What single word did you just reply with?', cwd: p.root, sessionId: result.sessionId, permissionMode: 'default', allowedTools: [], onEvent: (e) => followUp.push(e) });
  assert.match(followUp.find((e) => e.kind === 'result').text.toLowerCase(), /pong/);
});
