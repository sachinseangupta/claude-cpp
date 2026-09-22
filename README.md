# Claude C++

Write your instructions to Claude Code as a program — in C++ or in Python, switching
between them from the panel. It is compiled (C++) or run (Python); what it prints is
the message Claude receives.

You don't write English. You combine **concepts** (classes) and the vocabulary module words them:

| Kind | Meaning | Examples |
|---|---|---|
| `Subject` | a thing | `this_project`, `File("a.cpp")`, `Dir("src")`, `Function("parse", "a.cpp")` |
| `Aspect` | part of a thing | `Purpose(x)`, `Structure(x)`, `Components(x)`, `Dependencies(x)`, `Tests(x)`, `PublicApi(x)` |
| `Action` | a verb + things | `Read`, `List`, `Find`, `Explain`, `Summarize`, `Check`, `Run`, `Modify`, `Add`, `Remove`, `Fix` |
| `Format` | shape of the answer | `Summarize(x).in(Bullets(3))`, `.in(Sentences(2))` (Python: `.in_(...)`, since `in` is a keyword there) |
| `Condition` | a done-when | `Passing(x)`, `Compiling(x)`, `Unchanged(x)` |

## How it works

Opening a folder creates `.claude-cpp/` in it and shows two things side by side:

- **`instructions.cpp`** (or `instructions.py`) — a real file in the normal editor (syntax highlighting, red squiggles from the compiler or from Python errors, clangd/Pylance if you have them).
- **The Claude panel** — a **C++ / Python** switch, the compiled prompt, a **Send to Claude** button (`Cmd+Option+Enter`), and the conversation.

```cpp
#include "project.hpp"
using namespace claude;

int main() {
    Prompt p;
    p.goal(Explain(Purpose(this_project), Structure(this_project)));
    for (const Subject& thing : std::vector<Subject>{File("README.md"), Dir("src")})
        p.step(Read(thing));
    p.step(List(Components(this_project)));
    p.step(Summarize(this_project).in(Bullets(3)));
    p.forbid(Modify(this_project));
    return p.emit();
}
```

The same program in Python:

```python
from project import *

p = Prompt()
p.goal(Explain(Purpose(this_project), Structure(this_project)))
for thing in [File("README.md"), Dir("src")]:
    p.step(Read(thing))
p.step(List(Components(this_project)))
p.step(Summarize(this_project).in_(Bullets(3)))
p.forbid(Modify(this_project))
p.emit()
```

Both send:

```
# Goal
Explain the purpose of this project and the structure of this project.

## Steps, in order
1. Read the file `README.md`.
2. Read the directory `src`.
3. List the main components of this project.
4. Summarize this project in 3 bullet points.

## Constraints
- Do not modify this project.
```

Save → C++ compiles with `clang++ -std=c++20` and runs from the project root; Python runs directly with `python3` → the panel shows the result.
Loops, conditionals, functions and types are evaluated for real (by the compiler, or by the interpreter), so `for` really does generate steps.
Missing files and functions produce warnings instead of being silently sent. A raw string where a concept is expected is a compile error in C++, and a clear `TypeError` (squiggled on the offending line) in Python.

## Switching languages

The **C++ / Python** switch in the panel (or *Claude C++: Switch Instruction Language*) changes which file you edit and which panel button runs it. Both languages' files live side by side in `.claude-cpp/`, switching never deletes anything, and the Claude conversation carries over — it's about the work, not about how the message to Claude was written.

## Your project's own concepts

`.claude-cpp/project.hpp` (or `project.py`) is yours. Define a thing once, with where it lives, and use it by name; Claude is pointed at those places every time you mention it:

```cpp
struct ConfigParser : Subject {
    ConfigParser() : Subject("the config parser", {File("src/config.cpp")}) {}
};

p.step(Read(ConfigParser()));
p.forbid(Modify(PublicApi(ConfigParser())));   // "Do not modify the public API of the config parser."
```

```python
class ConfigParser(Subject):
    def __init__(self):
        super().__init__("the config parser", [File("src/config.py")])

p.step(Read(ConfigParser()))
p.forbid(Modify(PublicApi(ConfigParser())))
```

Aspects, verbs and conditions are extended the same way; `project.hpp` / `project.py` has a commented example of each. `p.note("...")` remains as free text for anything with no concept yet — if you write the same note twice, make it a concept.

Follow-up sends continue the same Claude Code session; **New conversation** starts fresh.

## Files it creates in your project

For each language you use: `.claude-cpp/instructions.cpp`/`.py` and `project.hpp`/`.py` (yours — never overwritten), `claude.hpp`/`claude.py` (the generic vocabulary and where all the English lives; read it, edit it, or reset it with the *Claude C++: Reset claude.hpp / claude.py* command). Also `compile_flags.txt` (C++ only, for clangd) and a shared `.gitignore` (ignores `build/` and `__pycache__/`). If your project uses git, `.claude-cpp/` is also added to the project's own `.gitignore`. To track it instead, put `!.claude-cpp/` in that file; any line that mentions `.claude-cpp` is left alone.

## Requirements

For C++: `clang++` (Xcode Command Line Tools). For Python: a `python3` on your `PATH` (or set `claudeCpp.python`). Either way, the [Claude Code CLI](https://claude.com/claude-code), logged in.

## Permissions

The panel talks to `claude -p`, which cannot ask you for approval, so anything not pre-approved is denied — and the panel tells you which tools were denied. The default mode is `acceptEdits` (file edits allowed, shell commands not). Adjust `claudeCpp.permissionMode` and `claudeCpp.allowedTools` (e.g. `"Bash(npm test)"`) in Settings.

## Trust

Compiling or running your program executes code, so both are disabled in untrusted workspaces.

## Settings

`claudeCpp.autoOpen`, `compileOnSave`, `compiler`, `cppStandard`, `extraCompilerFlags`, `python`, `claudePath`, `permissionMode`, `allowedTools`, `model`.

## Development

```
npm install
npm test                  # unit tests (compiler pipeline, CLI stream parsing, scaffold)
npm run test:integration  # launches VS Code and drives the extension
CLAUDE_CPP_LIVE=1 npm test  # also sends one real (paid) prompt to Claude
npm run package           # builds claude-cpp-0.1.0.vsix
```
