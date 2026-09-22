// Tests for the vscode-independent core. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAndRun, parseDiagnostics, parsePythonError } = require('../out/compiler');
const { parseStreamLine, runClaude } = require('../out/claude');
const { ensureScaffold, ensureGitignored, resetVocabulary } = require('../out/scaffold');

const ROOT = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cpp-test-'));

/** Set up a project dir with the header and the given instructions.cpp text. */
function project(source) {
  const root = tmp();
  const dir = path.join(root, '.claude-cpp');
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ROOT, 'include', 'claude.hpp'), path.join(dir, 'claude.hpp'));
  fs.copyFileSync(path.join(ROOT, 'templates', 'project.hpp'), path.join(dir, 'project.hpp'));
  fs.writeFileSync(path.join(dir, 'instructions.cpp'), source);
  return { root, source: path.join(dir, 'instructions.cpp'), buildDir: path.join(dir, 'build') };
}
const build = (p, extra = {}) =>
  buildAndRun({ compiler: 'clang++', standard: 'c++20', extraFlags: [], source: p.source, buildDir: p.buildDir, cwd: p.root, ...extra });

/** Same, for a Python instructions.py. */
function pyProject(source) {
  const root = tmp();
  const dir = path.join(root, '.claude-cpp');
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ROOT, 'include', 'claude.py'), path.join(dir, 'claude.py'));
  fs.copyFileSync(path.join(ROOT, 'templates', 'project.py'), path.join(dir, 'project.py'));
  fs.writeFileSync(path.join(dir, 'instructions.py'), source);
  return { root, dir, source: path.join(dir, 'instructions.py') };
}
const buildPy = (p, extra = {}) => buildAndRun({ language: 'python', python: 'python3', source: p.source, cwd: p.root, ...extra });

// ---------------------------------------------------------------- compiler
test('the starter template compiles and produces a prompt, with warnings for missing paths', async () => {
  const p = project(fs.readFileSync(path.join(ROOT, 'templates', 'instructions.cpp'), 'utf8'));
  const r = await build(p);
  assert.equal(r.ok, true, r.message + r.compilerOutput);
  assert.equal(
    r.prompt,
    [
      '# Goal',
      'Explain the purpose of this project and the structure of this project.',
      '',
      '## Steps, in order',
      '1. Read the file `README.md`.',
      '2. Read the directory `src`.',
      '3. List the main components of this project.',
      '4. Summarize this project in 3 bullet points.',
      '',
      '## Constraints',
      '- Do not modify this project.',
      '',
    ].join('\n'),
  );
  assert.match(r.runOutput, /warning: File not found: README\.md/);
  assert.match(r.runOutput, /warning: Directory not found: src/);
});

test('the starter template contains no natural-language string literals', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templates', 'instructions.cpp'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // Only paths (File/Dir arguments) are allowed as strings.
  const strings = [...code.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((t) => !/^(project\.hpp|README\.md|src)$/.test(t));
  assert.deepEqual(strings, []);
});

test('existing files and functions raise no warnings; loops generate steps', async () => {
  const p = project(`#include "claude.hpp"
using namespace claude;
int main() {
  Prompt p;
  p.goal(Read(File("a.txt")));
  p.context(File("a.txt"), Function("hello", "a.txt"));
  for (int i = 0; i < 2; ++i) p.step(Check(Function("hello")));
  return p.emit();
}`);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'void hello();');
  const r = await build(p);
  assert.equal(r.ok, true, r.message + r.compilerOutput);
  assert.equal(r.runOutput, '');
  assert.match(r.prompt, /## Look at first\n- The file `a\.txt`\n- The function `hello` in `a\.txt`\n/);
  assert.match(r.prompt, /1\. Check the function `hello`\.\n2\. Check the function `hello`\./);
});

test('a function missing from its file is flagged', async () => {
  const p = project(`#include "claude.hpp"
using namespace claude;
int main() { Prompt p; p.goal(Read(Function("nope", "a.txt"))); return p.emit(); }`);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'void hello();');
  const r = await build(p);
  assert.equal(r.ok, true, r.message + r.compilerOutput);
  assert.match(r.runOutput, /'nope' does not appear in a\.txt/);
});

test('actions, formats, conditions and multiple objects are worded by the header', async () => {
  const p = project(`#include "claude.hpp"
using namespace claude;
int main() {
  Prompt p;
  p.goal(Fix(Tests(this_project)));
  p.step(Summarize(this_project).in(Sentences(1)));
  p.step(Read(File("a.txt"), Dir("d"), this_project));
  p.step(Run(Tests(this_project)));
  p.forbid(Remove(PublicApi(this_project)));
  p.forbid(Add(Dependencies(this_project)));
  p.accept(Passing(Tests(this_project)));
  p.accept(Unchanged(PublicApi(this_project)));
  p.accept(Compiling(this_project));
  p.note("free text still works");
  return p.emit();
}`);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'x');
  fs.mkdirSync(path.join(p.root, 'd'));
  const r = await build(p);
  assert.equal(r.ok, true, r.message + r.compilerOutput);
  assert.equal(r.runOutput, '');
  assert.equal(
    r.prompt,
    [
      '# Goal',
      'Fix the tests of this project.',
      '',
      '## Steps, in order',
      '1. Summarize this project in 1 sentence.',
      '2. Read the file `a.txt`, the directory `d` and this project.',
      '3. Run the tests of this project.',
      '',
      '## Constraints',
      '- Do not remove the public API of this project.',
      '- Do not add the dependencies of this project.',
      '',
      '## Done when',
      '- Passing: the tests of this project',
      '- Unchanged: the public API of this project',
      '- Compiling: this project',
      '',
      '## Notes',
      '- free text still works',
      '',
    ].join('\n'),
  );
});

test('project concepts, aspects and verbs defined in project.hpp are usable and carry their locations', async () => {
  const p = project(`#include "project.hpp"
namespace claude {
struct ConfigParser : Subject {
  ConfigParser() : Subject("the config parser", {File("src/config.cpp"), Function("parse", "src/config.cpp")}) {}
};
struct Validation : Aspect {
  explicit Validation(const Subject& of) : Aspect("input validation", of) {}
};
struct Deprecate : Action {
  template <SubjectLike... S> requires(sizeof...(S) > 0)
  explicit Deprecate(const S&... what) : Action("deprecate", {what...}) {}
};
struct Documented : Condition {
  explicit Documented(const Subject& what) : Condition("documented", what) {}
};
}
using namespace claude;
int main() {
  Prompt p;
  p.goal(Check(Validation(ConfigParser())));
  p.step(Read(ConfigParser()));
  p.step(Deprecate(PublicApi(ConfigParser())));
  p.forbid(Modify(ConfigParser()));
  p.accept(Documented(ConfigParser()));
  return p.emit();
}`);
  fs.mkdirSync(path.join(p.root, 'src'));
  fs.writeFileSync(path.join(p.root, 'src', 'config.cpp'), 'void parse();');
  const r = await build(p);
  assert.equal(r.ok, true, r.message + r.compilerOutput);
  assert.equal(r.runOutput, '');
  assert.equal(
    r.prompt,
    [
      '# Goal',
      'Check the input validation of the config parser.',
      '',
      '## Look at first',
      // each mentioned concept is listed once, with where it lives
      '- The input validation of the config parser (the file `src/config.cpp` and the function `parse` in `src/config.cpp`)',
      '- The config parser (the file `src/config.cpp` and the function `parse` in `src/config.cpp`)',
      '- The public API of the config parser (the file `src/config.cpp` and the function `parse` in `src/config.cpp`)',
      '',
      '## Steps, in order',
      '1. Read the config parser.',
      '2. Deprecate the public API of the config parser.',
      '',
      '## Constraints',
      '- Do not modify the config parser.',
      '',
      '## Done when',
      '- Documented: the config parser',
      '',
    ].join('\n'),
  );
});

test('a step without an object does not compile', async () => {
  const p = project(`#include "claude.hpp"
using namespace claude;
int main() { Prompt p; p.goal(Read()); return p.emit(); }`);
  const r = await build(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'compile');
});

test('a raw string is not accepted where a concept is expected', async () => {
  const p = project(`#include "claude.hpp"
using namespace claude;
int main() { Prompt p; p.goal("Explain the project."); return p.emit(); }`);
  const r = await build(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'compile');
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
int main() { claude::Prompt p; p.goal(claude::Read(claude::this_project)); return p.emit(); }`);
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
int main() { claude::Prompt p; p.goal(claude::Read(claude::File("marker.txt"))); return p.emit(); }`);
  fs.writeFileSync(path.join(p.root, 'marker.txt'), 'x');
  const r = await build(p);
  assert.equal(r.runOutput, '');
});

test('parseDiagnostics understands clang output', () => {
  const d = parseDiagnostics('/a/b.cpp:12:5: error: use of undeclared identifier \'x\'\n  x = 1;\n  ^\n/a/b.cpp:3:1: warning: unused\n/a/b.cpp:3:1: note: here\nfatal error: none');
  assert.deepEqual(d.map((x) => [x.line, x.column, x.severity]), [[12, 5, 'error'], [3, 1, 'warning'], [3, 1, 'note']]);
});

// ---------------------------------------------------------------- python
const STARTER_PROMPT = [
  '# Goal',
  'Explain the purpose of this project and the structure of this project.',
  '',
  '## Steps, in order',
  '1. Read the file `README.md`.',
  '2. Read the directory `src`.',
  '3. List the main components of this project.',
  '4. Summarize this project in 3 bullet points.',
  '',
  '## Constraints',
  '- Do not modify this project.',
  '',
].join('\n');

test('python: the starter template runs and produces the same prompt as the C++ one, with warnings for missing paths', async () => {
  const p = pyProject(fs.readFileSync(path.join(ROOT, 'templates', 'instructions.py'), 'utf8'));
  const r = await buildPy(p);
  assert.equal(r.ok, true, r.message + r.runOutput);
  assert.equal(r.prompt, STARTER_PROMPT);
  assert.match(r.runOutput, /warning: File not found: README\.md/);
  assert.match(r.runOutput, /warning: Directory not found: src/);
  assert.match(r.message, /^Ran\./);
});

test('python: the starter template contains no natural-language string literals', () => {
  const src = fs.readFileSync(path.join(ROOT, 'templates', 'instructions.py'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const strings = [...code.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((t) => !/^(README\.md|src)$/.test(t));
  assert.deepEqual(strings, []);
});

test('python: running leaves no __pycache__ behind', async () => {
  const p = pyProject('from project import *\np = Prompt()\np.goal(Read(this_project))\np.emit()\n');
  assert.equal((await buildPy(p)).ok, true);
  assert.equal(fs.existsSync(path.join(p.dir, '__pycache__')), false);
});

test('python: existing files and functions raise no warnings; loops generate steps; missing functions are flagged', async () => {
  const p = pyProject(`from project import *
p = Prompt()
p.goal(Read(File("a.txt")))
p.context(File("a.txt"), Function("hello", "a.txt"))
for i in range(2):
    p.step(Check(Function("hello")))
p.step(Read(Function("nope", "a.txt")))
p.emit()
`);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'void hello();');
  const r = await buildPy(p);
  assert.equal(r.ok, true, r.message + r.runOutput);
  assert.equal(r.runOutput, "warning: 'nope' does not appear in a.txt\n");
  assert.match(r.prompt, /## Look at first\n- The file `a\.txt`\n- The function `hello` in `a\.txt`\n/);
  assert.match(r.prompt, /1\. Check the function `hello`\.\n2\. Check the function `hello`\./);
});

const ACTIONS_CPP = `#include "claude.hpp"
using namespace claude;
int main() {
  Prompt p;
  p.goal(Fix(Tests(this_project)));
  p.step(Summarize(this_project).in(Sentences(1)));
  p.step(Read(File("a.txt"), Dir("d"), this_project));
  p.step(Run(Tests(this_project)));
  p.forbid(Remove(PublicApi(this_project)));
  p.forbid(Add(Dependencies(this_project)));
  p.accept(Passing(Tests(this_project)));
  p.accept(Unchanged(PublicApi(this_project)));
  p.accept(Compiling(this_project));
  p.note("free text still works\\nover two lines");
  return p.emit();
}`;
const ACTIONS_PY = `from project import *
p = Prompt()
p.goal(Fix(Tests(this_project)))
p.step(Summarize(this_project).in_(Sentences(1)))
p.step(Read(File("a.txt"), Dir("d"), this_project))
p.step(Run(Tests(this_project)))
p.forbid(Remove(PublicApi(this_project)))
p.forbid(Add(Dependencies(this_project)))
p.accept(Passing(Tests(this_project)))
p.accept(Unchanged(PublicApi(this_project)))
p.accept(Compiling(this_project))
p.note("free text still works\\nover two lines")
p.emit()
`;
const ACTIONS_PROMPT = [
  '# Goal',
  'Fix the tests of this project.',
  '',
  '## Steps, in order',
  '1. Summarize this project in 1 sentence.',
  '2. Read the file `a.txt`, the directory `d` and this project.',
  '3. Run the tests of this project.',
  '',
  '## Constraints',
  '- Do not remove the public API of this project.',
  '- Do not add the dependencies of this project.',
  '',
  '## Done when',
  '- Passing: the tests of this project',
  '- Unchanged: the public API of this project',
  '- Compiling: this project',
  '',
  '## Notes',
  '- free text still works',
  '  over two lines',
  '',
].join('\n');

test('python: actions, formats, conditions and multiple objects are worded by claude.py', async () => {
  const p = pyProject(ACTIONS_PY);
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'x');
  fs.mkdirSync(path.join(p.root, 'd'));
  const r = await buildPy(p);
  assert.equal(r.ok, true, r.message + r.runOutput);
  assert.equal(r.runOutput, '');
  assert.equal(r.prompt, ACTIONS_PROMPT);
});

test('the same program in C++ and in Python sends the identical message', async () => {
  const cpp = project(ACTIONS_CPP);
  const py = pyProject(ACTIONS_PY);
  for (const root of [cpp.root, py.root]) {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.mkdirSync(path.join(root, 'd'));
  }
  const [c, y] = [await build(cpp), await buildPy(py)];
  assert.equal(c.ok, true, c.message + c.compilerOutput);
  assert.equal(y.ok, true, y.message + y.runOutput);
  assert.equal(y.prompt, c.prompt);
  assert.equal(c.prompt, ACTIONS_PROMPT);
});

test('python: project concepts, aspects and verbs defined in project.py are usable and carry their locations', async () => {
  const p = pyProject(`from project import *

class ConfigParser(Subject):
    def __init__(self):
        super().__init__("the config parser", [File("src/config.py"), Function("parse", "src/config.py")])

class Validation(Aspect):
    def __init__(self, of):
        super().__init__("input validation", of)

class Deprecate(Action):
    def __init__(self, *what):
        super().__init__("deprecate", *what)

class Documented(Condition):
    def __init__(self, what):
        super().__init__("documented", what)

p = Prompt()
p.goal(Check(Validation(ConfigParser())))
p.step(Read(ConfigParser()))
p.step(Deprecate(PublicApi(ConfigParser())))
p.forbid(Modify(ConfigParser()))
p.accept(Documented(ConfigParser()))
p.emit()
`);
  fs.mkdirSync(path.join(p.root, 'src'));
  fs.writeFileSync(path.join(p.root, 'src', 'config.py'), 'def parse(): pass');
  const r = await buildPy(p);
  assert.equal(r.ok, true, r.message + r.runOutput);
  assert.equal(r.runOutput, '');
  const where = '(the file `src/config.py` and the function `parse` in `src/config.py`)';
  assert.equal(
    r.prompt,
    [
      '# Goal',
      'Check the input validation of the config parser.',
      '',
      '## Look at first',
      `- The input validation of the config parser ${where}`,
      `- The config parser ${where}`,
      `- The public API of the config parser ${where}`,
      '',
      '## Steps, in order',
      '1. Read the config parser.',
      '2. Deprecate the public API of the config parser.',
      '',
      '## Constraints',
      '- Do not modify the config parser.',
      '',
      '## Done when',
      '- Documented: the config parser',
      '',
    ].join('\n'),
  );
});

test('python: a raw string is rejected where a concept is expected, and the squiggle lands on the call in instructions.py', async () => {
  const p = pyProject('from project import *\np = Prompt()\np.goal(Explain(this_project))\np.step(Read("the config file"))\np.emit()\n');
  const r = await buildPy(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'run');
  assert.match(r.message, /^TypeError: Read\(\) needs a concept .* but got the text 'the config file'/);
  assert.equal(r.prompt, '');
  assert.equal(r.diagnostics.length, 1, r.runOutput);
  assert.equal(r.diagnostics[0].line, 4); // not a line inside claude.py, where the TypeError is raised
  assert.equal(path.basename(r.diagnostics[0].file), 'instructions.py');
  assert.equal(r.diagnostics[0].severity, 'error');
});

test('python: the wrong kind of argument is reported by name for every builder method', async () => {
  const cases = [
    ['Read()', /Read\(\) needs at least one thing to act on/],
    ['Prompt().goal(this_project)', /Prompt\.goal\(\) needs an action .* a value of type Project/],
    ['Prompt().step("read it")', /Prompt\.step\(\) needs an action/],
    ['Prompt().accept(Read(this_project))', /Prompt\.accept\(\) needs a condition/],
    ['Purpose("x")', /Purpose\(\) needs a concept/],
    ['Summarize(this_project).in_("brief")', /Summarize\.in_\(\) needs a format/],
    ['Bullets("3")', /Bullet point needs a whole number/],
  ];
  for (const [expr, expected] of cases) {
    const r = await buildPy(pyProject(`from project import *\n${expr}\n`));
    assert.equal(r.ok, false, expr);
    assert.match(r.message, expected, expr);
  }
});

test('python: a syntax error is a compile-stage failure with the squiggle on the right line', async () => {
  const p = pyProject('from project import *\np = Prompt()\np.goal(Explain(this_project)\np.emit()\n');
  const r = await buildPy(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'compile');
  assert.match(r.message, /^SyntaxError/);
  assert.equal(r.diagnostics.length, 1, r.runOutput);
  assert.ok(r.diagnostics[0].line >= 3 && r.diagnostics[0].line <= 4, String(r.diagnostics[0].line));
  assert.equal(r.prompt, '');
});

test('python: an error inside project.py is flagged in project.py', async () => {
  const p = pyProject('from project import *\np = Prompt()\np.goal(Read(this_project))\np.emit()\n');
  fs.appendFileSync(path.join(p.dir, 'project.py'), '\nundefined_name\n');
  const r = await buildPy(p);
  assert.equal(r.ok, false);
  assert.match(r.message, /^NameError/);
  assert.equal(path.basename(r.diagnostics[0].file), 'project.py');
});

test('python: a prompt without a goal fails with a helpful message on the emit() line', async () => {
  const p = pyProject('from project import *\np = Prompt()\np.emit()\n');
  const r = await buildPy(p);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'run');
  // Python qualifies a custom exception with the module that defines it -- "claude.PromptError", not "PromptError".
  assert.match(r.message, /^claude\.PromptError: this prompt has no goal/);
  assert.equal(r.diagnostics[0].line, 3);
});

test('python: a program that prints nothing is not sendable; sys.exit reports its exit code', async () => {
  let r = await buildPy(pyProject('x = 1\n'));
  assert.equal(r.ok, false);
  assert.match(r.message, /printed nothing/);
  r = await buildPy(pyProject('import sys\nsys.exit(3)\n'));
  assert.equal(r.ok, false);
  assert.match(r.message, /exited with code 3/);
  assert.deepEqual(r.diagnostics, []);
});

test('python: an infinite loop is stopped by the run timeout', async () => {
  const r = await buildPy(pyProject('while True:\n    pass\n'), { runTimeoutMs: 400 });
  assert.equal(r.ok, false);
  assert.match(r.message, /longer than 0.4 seconds/);
});

test('python: a missing interpreter gives an actionable message', async () => {
  const r = await buildPy(pyProject('print(1)\n'), { python: 'definitely-not-python' });
  assert.equal(r.ok, false);
  assert.match(r.message, /Python "definitely-not-python" was not found.*claudeCpp\.python/);
});

test('python: aborting cancels the run', async () => {
  const ac = new AbortController();
  const pending = buildPy(pyProject('import time\ntime.sleep(5)\n'), { signal: ac.signal });
  ac.abort();
  assert.equal((await pending).aborted, true);
});

test('python: the program runs from the project root so relative paths resolve, and can import its neighbours', async () => {
  const p = pyProject('from project import *\np = Prompt()\np.goal(Read(File("marker.txt")))\np.emit()\n');
  fs.writeFileSync(path.join(p.root, 'marker.txt'), 'x');
  const r = await buildPy(p);
  assert.equal(r.ok, true, r.message + r.runOutput);
  assert.equal(r.runOutput, '');
});

test('non-ASCII text survives the trip through Python', async () => {
  const r = await buildPy(pyProject('from project import *\np = Prompt()\np.goal(Read(File("naïve—日本語.txt")))\np.emit()\n'));
  assert.equal(r.ok, true, r.message);
  assert.match(r.prompt, /naïve—日本語\.txt/);
});

test('parsePythonError picks the innermost user frame, skipping the vocabulary and the standard library', () => {
  const dir = '/w/.claude-cpp';
  const tb = [
    'warning: File not found: x',
    'Traceback (most recent call last):',
    '  File "/w/.claude-cpp/instructions.py", line 7, in <module>',
    '    p.step(Read("x"))',
    '  File "/w/.claude-cpp/claude.py", line 200, in __init__',
    '    raise TypeError(...)',
    'TypeError: Read() needs a concept',
  ].join('\n');
  assert.deepEqual(parsePythonError(tb, dir, 'claude.py'), {
    message: 'TypeError: Read() needs a concept',
    syntax: false,
    diagnostics: [{ file: '/w/.claude-cpp/instructions.py', line: 7, column: 1, severity: 'error', message: 'TypeError: Read() needs a concept' }],
  });

  const stdlib = ['Traceback (most recent call last):', '  File "/w/.claude-cpp/instructions.py", line 2, in <module>', '  File "/usr/lib/python3/json/__init__.py", line 9, in load', 'ValueError: bad'].join('\n');
  assert.equal(parsePythonError(stdlib, dir, 'claude.py').diagnostics[0].line, 2);

  const syntax = ['  File "/w/.claude-cpp/instructions.py", line 3', '    p.goal(', '          ^', 'SyntaxError: \'(\' was never closed'].join('\n');
  assert.equal(parsePythonError(syntax, dir, 'claude.py').syntax, true);

  assert.equal(parsePythonError('warning: something\n', dir, 'claude.py'), undefined); // no traceback: not an exception
});

// ---------------------------------------------------------------- scaffold
test('scaffold creates the files once and never overwrites user edits', () => {
  const root = tmp();
  const s = ensureScaffold(root, ROOT);
  assert.ok(s.createdSource);
  for (const f of [s.source, s.vocabulary, path.join(s.dir, 'project.hpp'), path.join(s.dir, '.gitignore'), path.join(s.dir, 'compile_flags.txt')]) assert.ok(fs.existsSync(f), f);
  fs.writeFileSync(s.source, '// mine');
  fs.writeFileSync(s.vocabulary, '// my header');
  fs.writeFileSync(path.join(s.dir, 'project.hpp'), '// my concepts');
  const again = ensureScaffold(root, ROOT);
  assert.equal(again.createdSource, false);
  assert.equal(fs.readFileSync(s.source, 'utf8'), '// mine');
  assert.equal(fs.readFileSync(s.vocabulary, 'utf8'), '// my header');
  assert.equal(fs.readFileSync(path.join(s.dir, 'project.hpp'), 'utf8'), '// my concepts');
  resetVocabulary(root, ROOT);
  assert.match(fs.readFileSync(s.vocabulary, 'utf8'), /CLAUDE_CPP_HEADER_VERSION/);
});

test('python scaffold creates its own files beside the C++ ones, once, and never overwrites user edits', () => {
  const root = tmp();
  const s = ensureScaffold(root, ROOT, 'python');
  assert.equal(s.language, 'python');
  assert.ok(s.createdSource);
  assert.equal(path.basename(s.source), 'instructions.py');
  assert.equal(path.basename(s.vocabulary), 'claude.py');
  for (const f of [s.source, s.vocabulary, path.join(s.dir, 'project.py'), path.join(s.dir, '.gitignore')]) assert.ok(fs.existsSync(f), f);
  // starting in Python does not litter the folder with C++ files
  for (const f of ['instructions.cpp', 'claude.hpp', 'project.hpp', 'compile_flags.txt']) assert.equal(fs.existsSync(path.join(s.dir, f)), false, f);
  assert.match(fs.readFileSync(path.join(s.dir, '.gitignore'), 'utf8'), /__pycache__/);

  fs.writeFileSync(s.source, '# mine');
  fs.writeFileSync(path.join(s.dir, 'project.py'), '# my concepts');
  // switching to C++ adds its files and leaves the Python ones alone; switching back is a no-op
  const cpp = ensureScaffold(root, ROOT, 'cpp');
  assert.ok(cpp.createdSource);
  assert.ok(fs.existsSync(path.join(s.dir, 'compile_flags.txt')));
  const again = ensureScaffold(root, ROOT, 'python');
  assert.equal(again.createdSource, false);
  assert.equal(fs.readFileSync(s.source, 'utf8'), '# mine');
  assert.equal(fs.readFileSync(path.join(s.dir, 'project.py'), 'utf8'), '# my concepts');

  fs.writeFileSync(s.vocabulary, '# broken');
  resetVocabulary(root, ROOT, 'python');
  assert.match(fs.readFileSync(s.vocabulary, 'utf8'), /CLAUDE_PY_HEADER_VERSION/);
  assert.match(fs.readFileSync(cpp.vocabulary, 'utf8'), /CLAUDE_CPP_HEADER_VERSION/); // the other language's file is untouched
});

test('.claude-cpp/ is added to the project .gitignore: appended, once, and only for git projects', () => {
  const read = (root) => fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

  // existing .gitignore, no trailing newline: content preserved, entry on its own line
  let root = tmp();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/');
  ensureScaffold(root, ROOT);
  assert.equal(read(root), 'node_modules/\n.claude-cpp/\n');
  // opening again does not duplicate it
  ensureScaffold(root, ROOT);
  assert.equal(read(root), 'node_modules/\n.claude-cpp/\n');

  // a git repo with no .gitignore gets one
  root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  ensureScaffold(root, ROOT);
  assert.equal(read(root), '.claude-cpp/\n');

  // not a git project: no .gitignore is invented
  root = tmp();
  ensureScaffold(root, ROOT);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('an existing decision about .claude-cpp in .gitignore is respected', () => {
  for (const existing of ['.claude-cpp\n', '/.claude-cpp/\n', '.claude-cpp/*\n', '!.claude-cpp/\n', 'dist/\n!.claude-cpp/project.hpp\n']) {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.gitignore'), existing);
    assert.equal(ensureGitignored(root), false, existing);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), existing);
  }
  // a comment that merely mentions it does not count
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitignore'), '# .claude-cpp is not ignored yet\n');
  assert.equal(ensureGitignored(root), true);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\n\.claude-cpp\/\n$/);
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
int main() { using namespace claude; Prompt p; p.goal(Action("reply with", {Subject("exactly the single word: pong")})); p.forbid(Action("use", {Subject("any tools")})); return p.emit(); }`);
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
