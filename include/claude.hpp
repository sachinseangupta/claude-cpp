// claude.hpp  --  the tiny "standard library" for talking to Claude in C++.
//
// You write a normal C++ program. When it runs, whatever it prints to stdout
// becomes the message sent to Claude. This header gives you the vocabulary
// (Prompt, File, Dir, Function) so the message comes out well-structured.
//
// Feel free to read this file and change it -- it is ordinary C++20.
// (Command palette: "Claude C++: Reset claude.hpp" restores the bundled copy.)

#pragma once

#define CLAUDE_CPP_HEADER_VERSION 1

#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace claude {

// ---------------------------------------------------------------------------
// Targets: the parts of your project you want Claude to look at.
// ---------------------------------------------------------------------------

enum class TargetKind { File, Dir, Function };

struct Target {
    TargetKind kind;
    std::string name;   // a path, or a function name
    std::string where;  // for functions: the file it lives in (may be empty)
};

namespace detail {

// Warnings go to stderr, which the panel shows next to the compiled prompt.
inline void warn(const std::string& message) {
    std::cerr << "warning: " << message << '\n';
}

inline std::string read_file(const std::string& path) {
    std::ifstream in(path);
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

}  // namespace detail

// A file, relative to the project root. Warns if it does not exist.
struct File : Target {
    explicit File(std::string path)
        : Target{TargetKind::File, std::move(path), ""} {
        if (!std::filesystem::is_regular_file(name)) {
            detail::warn("File not found: " + name);
        }
    }
};

// A directory, relative to the project root. Warns if it does not exist.
struct Dir : Target {
    explicit Dir(std::string path)
        : Target{TargetKind::Dir, std::move(path), ""} {
        if (!std::filesystem::is_directory(name)) {
            detail::warn("Directory not found: " + name);
        }
    }
};

// A function, optionally pinned to the file that defines it. If you give a
// file, the function name is searched for in it and a warning is raised when
// the text does not appear.
struct Function : Target {
    explicit Function(std::string function_name, std::string in_file = "")
        : Target{TargetKind::Function, std::move(function_name), std::move(in_file)} {
        if (where.empty()) return;
        if (!std::filesystem::is_regular_file(where)) {
            detail::warn("File not found: " + where);
        } else if (detail::read_file(where).find(name) == std::string::npos) {
            detail::warn("'" + name + "' does not appear in " + where);
        }
    }
};

// ---------------------------------------------------------------------------
// Prompt: builds the message. Every method returns *this so calls can chain:
//     Prompt p;
//     p.goal("...").constrain("...");
// ---------------------------------------------------------------------------

class Prompt {
public:
    // What you want done. Required -- emit() fails without one.
    Prompt& goal(std::string text) {
        goal_ = std::move(text);
        return *this;
    }

    // Parts of the project Claude should look at first.
    Prompt& context(const Target& target) {
        context_.push_back(target);
        return *this;
    }
    Prompt& context(std::initializer_list<Target> targets) {
        for (const Target& t : targets) context_.push_back(t);
        return *this;
    }

    // One action, in order. Call it in a loop to generate steps.
    Prompt& step(std::string text) {
        steps_.push_back(std::move(text));
        return *this;
    }

    // Rules Claude must respect while working.
    Prompt& constrain(std::string text) {
        constraints_.push_back(std::move(text));
        return *this;
    }

    // How you will judge the result ("done when ...").
    Prompt& accept(std::string text) {
        acceptance_.push_back(std::move(text));
        return *this;
    }

    // Anything that does not fit above.
    Prompt& note(std::string text) {
        notes_.push_back(std::move(text));
        return *this;
    }

    // The message as Markdown.
    std::string render() const {
        std::ostringstream out;
        out << "# Goal\n" << goal_ << "\n";

        if (!context_.empty()) {
            out << "\n## Look at first\n";
            for (const Target& t : context_) out << "- " << describe(t) << '\n';
        }
        if (!steps_.empty()) {
            out << "\n## Steps, in order\n";
            for (std::size_t i = 0; i < steps_.size(); ++i) {
                out << (i + 1) << ". " << indent_continuation(steps_[i], 3) << '\n';
            }
        }
        bullets(out, "Constraints", constraints_);
        bullets(out, "Done when", acceptance_);
        bullets(out, "Notes", notes_);
        return out.str();
    }

    // Print the message to stdout. Use as the last line of main():
    //     return p.emit();
    // The return value is main's exit code: 0 = fine, 1 = nothing to send.
    int emit() const {
        if (goal_.empty()) {
            std::cerr << "error: this prompt has no goal. Call p.goal(\"...\").\n";
            return 1;
        }
        std::cout << render();
        return 0;
    }

private:
    static std::string describe(const Target& t) {
        switch (t.kind) {
            case TargetKind::File: return "File `" + t.name + "`";
            case TargetKind::Dir: return "Directory `" + t.name + "`";
            case TargetKind::Function:
                return t.where.empty()
                           ? "Function `" + t.name + "`"
                           : "Function `" + t.name + "` in `" + t.where + "`";
        }
        return t.name;  // unreachable, keeps the compiler happy
    }

    // "a\nb" -> "a\n   b" so multi-line text stays inside its list item.
    static std::string indent_continuation(const std::string& text, int spaces) {
        std::string result;
        for (char c : text) {
            result += c;
            if (c == '\n') result.append(static_cast<std::size_t>(spaces), ' ');
        }
        return result;
    }

    static void bullets(std::ostringstream& out, const char* title,
                        const std::vector<std::string>& items) {
        if (items.empty()) return;
        out << "\n## " << title << '\n';
        for (const std::string& item : items) out << "- " << indent_continuation(item, 2) << '\n';
    }

    std::string goal_;
    std::vector<Target> context_;
    std::vector<std::string> steps_;
    std::vector<std::string> constraints_;
    std::vector<std::string> acceptance_;
    std::vector<std::string> notes_;
};

}  // namespace claude
