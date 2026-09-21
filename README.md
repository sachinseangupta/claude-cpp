# Claude C++

Write your instructions to Claude Code as a C++ program. It is compiled and run;
what it prints is the message Claude receives.

## How it works

Opening a folder creates `.claude-cpp/` in it and shows two things side by side:

- **`instructions.cpp`** — a real C++ file in the normal editor (syntax highlighting, red squiggles from the compiler, clangd if you have it).
- **The Claude panel** — the compiled prompt, a **Send to Claude** button (`Cmd+Option+Enter`), and the conversation.

```cpp
#include "claude.hpp"
using namespace claude;

int main() {
    Prompt p;
    p.goal("Add input validation to the config parser.");
    p.context({File("src/config.cpp"), Function("parse", "src/config.cpp")});
    for (const std::string& s : {"Find every unchecked field.", "Add checks.", "Add a test per check."})
        p.step(s);
    p.constrain("Do not change the public API.");
    p.accept("All existing tests still pass.");
    return p.emit();
}
```

Save → compiles with `clang++ -std=c++20` and runs from the project root → the panel shows the result.
Loops, conditionals, functions and types are evaluated by the real compiler, so `for` really does generate steps.
Missing files and functions produce warnings instead of being silently sent.

Follow-up sends continue the same Claude Code session; **New conversation** starts fresh.

## Files it creates in your project

`.claude-cpp/instructions.cpp` (yours — never overwritten), `claude.hpp` (the vocabulary; read it, edit it, or reset it with the *Claude C++: Reset claude.hpp* command), `compile_flags.txt`, `.gitignore` (ignores `build/`).

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
