// instructions.cpp  --  your message to Claude, written in C++.
//
//   1. Edit this file.
//   2. Save (Cmd+S). It is compiled and run; the panel on the right shows the
//      text it produced.
//   3. When the preview looks right, press "Send to Claude"
//      (or Cmd+Option+Enter).
//
// Compiler errors show up here as red squiggles and in the panel. Fixing them
// is part of the job -- that is the point of this tool.

#include "claude.hpp"

#include <string>
#include <vector>

using namespace claude;

int main() {
    Prompt p;

    p.goal("Explain what this project does and how it is organised.");

    // Point Claude at the parts of the project that matter. Each of these
    // warns (in the panel) if the path does not exist.
    p.context({File("README.md"), Dir("src")});

    // Ordinary C++ builds the steps: a vector and a range-based for loop.
    const std::vector<std::string> steps = {
        "Read the README and skim the top-level files.",
        "List the main components and what each is responsible for.",
        "Summarise the whole thing in three bullet points.",
    };
    for (const std::string& s : steps) {
        p.step(s);
    }

    p.constrain("Do not modify any files.");
    p.accept("I can explain the project to someone else after reading your answer.");

    return p.emit();
}
