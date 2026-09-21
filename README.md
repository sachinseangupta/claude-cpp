# Claude C++

Write your instructions to Claude Code as a C++ program. It is compiled and run;
what it prints is the message Claude receives.

You don't write English. You combine **concepts** (classes) and the vocabulary header words them:

| Kind | Meaning | Examples |
|---|---|---|
| `Subject` | a thing | `this_project`, `File("a.cpp")`, `Dir("src")`, `Function("parse", "a.cpp")` |
| `Aspect` | part of a thing | `Purpose(x)`, `Structure(x)`, `Components(x)`, `Dependencies(x)`, `Tests(x)`, `PublicApi(x)` |
| `Action` | a verb + things | `Read`, `List`, `Find`, `Explain`, `Summarize`, `Check`, `Run`, `Modify`, `Add`, `Remove`, `Fix` |
| `Format` | shape of the answer | `Summarize(x).in(Bullets(3))`, `.in(Sentences(2))` |
| `Condition` | a done-when | `Passing(x)`, `Compiling(x)`, `Unchanged(x)` |

## How it works

Opening a folder creates `.claude-cpp/` in it and shows two things side by side:

- **`instructions.cpp`** — a real C++ file in the normal editor (syntax highlighting, red squiggles from the compiler, clangd if you have it).
- **The Claude panel** — the compiled prompt, a **Send to Claude** button (`Cmd+Option+Enter`), and the conversation.

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

which sends:

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

Save → compiles with `clang++ -std=c++20` and runs from the project root → the panel shows the result.
Loops, conditionals, functions and types are evaluated by the real compiler, so `for` really does generate steps.
Missing files and functions produce warnings instead of being silently sent. A raw string where a concept is expected is a compile error.

## Your project's own concepts

`.claude-cpp/project.hpp` is yours. Define a thing once, with where it lives, and use it by name; Claude is pointed at those places every time you mention it:

```cpp
struct ConfigParser : Subject {
    ConfigParser() : Subject("the config parser", {File("src/config.cpp")}) {}
};

p.step(Read(ConfigParser()));
p.forbid(Modify(PublicApi(ConfigParser())));   // "Do not modify the public API of the config parser."
```

Aspects, verbs and conditions are extended the same way; `project.hpp` has a commented example of each. `p.note("...")` remains as free text for anything with no concept yet — if you write the same note twice, make it a concept.

Follow-up sends continue the same Claude Code session; **New conversation** starts fresh.

## Files it creates in your project

`.claude-cpp/instructions.cpp` and `project.hpp` (yours — never overwritten), `claude.hpp` (the generic vocabulary and where all the English lives; read it, edit it, or reset it with the *Claude C++: Reset claude.hpp* command), `compile_flags.txt`, and `.gitignore` (ignores `build/`). If your project uses git, `.claude-cpp/` is also added to the project's own `.gitignore`. To track it instead, put `!.claude-cpp/` in that file; any line that mentions `.claude-cpp` is left alone.

## Requirements

`clang++` (Xcode Command Line Tools) and the [Claude Code CLI](https://claude.com/claude-code), logged in.

## Permissions

The panel talks to `claude -p`, which cannot ask you for approval, so anything not pre-approved is denied — and the panel tells you which tools were denied. The default mode is `acceptEdits` (file edits allowed, shell commands not). Adjust `claudeCpp.permissionMode` and `claudeCpp.allowedTools` (e.g. `"Bash(npm test)"`) in Settings.

## Trust

Compiling runs your program, so it is disabled in untrusted workspaces.

## Settings

`claudeCpp.autoOpen`, `compileOnSave`, `compiler`, `cppStandard`, `extraCompilerFlags`, `claudePath`, `permissionMode`, `allowedTools`, `model`.

## Development

```
npm install
npm test                  # unit tests (compiler pipeline, CLI stream parsing, scaffold)
npm run test:integration  # launches VS Code and drives the extension
CLAUDE_CPP_LIVE=1 npm test  # also sends one real (paid) prompt to Claude
npm run package           # builds claude-cpp-0.1.0.vsix
```
