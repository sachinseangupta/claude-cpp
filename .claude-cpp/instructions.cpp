// instructions.cpp  --  your message to Claude, written in C++.
//
//   1. Edit this file.
//   2. Save (Cmd+S). It is compiled and run; the panel on the right shows the
//      text it produced.
//   3. When the preview looks right, press "Send to Claude"
//      (or Cmd+Option+Enter).
//
// You do not write English here. You combine concepts -- Subjects (things),
// Actions (verbs), Conditions (done-when) -- and claude.hpp words them.
// Your own concepts for this project go in project.hpp.
//
// Compiler errors show up here as red squiggles and in the panel. Fixing them
// is part of the job -- that is the point of this tool.

#include "project.hpp"

#include <vector>

using namespace claude;

int main() {
    Prompt p;

    p.goal(Explain(Purpose(this_project), Structure(this_project)));

    // Ordinary C++ builds the steps: a vector and a range-based for loop.
    // Each of these warns (in the panel) if the path does not exist.
    const std::vector<Subject> to_read = {File("README.md"), Dir("src")};
    for (const Subject& thing : to_read) {
        p.step(Read(thing));
    }
    p.step(List(Components(this_project)));
    p.step(Summarize(this_project).in(Bullets(3)));

    p.forbid(Modify(this_project));

    return p.emit();
}
