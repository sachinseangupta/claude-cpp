// claude.hpp  --  the vocabulary for writing instructions to Claude in C++.
//
// You write a normal C++ program. When it runs, whatever it prints to stdout
// becomes the message sent to Claude. Instead of writing English, you combine
// concepts (classes) and let this header do the wording:
//
//     Prompt p;
//     p.goal(Explain(Purpose(this_project)));
//     p.step(Read(File("README.md")));
//     p.forbid(Modify(this_project));
//     return p.emit();
//
//   Subject    a thing:        this_project, File, Dir, Function, or your own
//   Aspect     part of a thing: Purpose(x), Structure(x), Tests(x), PublicApi(x)
//   Action     a verb + things: Read(x), List(x), Modify(x), Summarize(x).in(Bullets(3))
//   Condition  a done-when:     Passing(x), Compiling(x), Unchanged(x)
//
// The English lives in this file, once. Your own concepts go in project.hpp.
// Feel free to read and change this file -- it is ordinary C++20.
// (Command palette: "Claude C++: Reset claude.hpp" restores the bundled copy.)

#pragma once

#define CLAUDE_CPP_HEADER_VERSION 2

#include <cctype>
#include <concepts>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace claude {

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

inline std::string capitalize(std::string text) {
    if (!text.empty()) text[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(text[0])));
    return text;
}

// {"a"} -> "a"   {"a","b"} -> "a and b"   {"a","b","c"} -> "a, b and c"
inline std::string join(const std::vector<std::string>& items) {
    std::string out;
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i > 0) out += (i + 1 == items.size()) ? " and " : ", ";
        out += items[i];
    }
    return out;
}

// "a\nb" -> "a\n   b" so multi-line text stays inside its list item.
inline std::string indent_continuation(const std::string& text, int spaces) {
    std::string result;
    for (char c : text) {
        result += c;
        if (c == '\n') result.append(static_cast<std::size_t>(spaces), ' ');
    }
    return result;
}

}  // namespace detail

// ---------------------------------------------------------------------------
// Subject: a thing an instruction can be about.
//
// A subject is a noun phrase, plus optionally the places it lives. Claude is
// pointed at those places whenever the subject is mentioned, so defining a
// concept once (in project.hpp) means you never repeat where it is.
// ---------------------------------------------------------------------------

class Subject {
public:
    explicit Subject(std::string phrase, std::vector<Subject> locations = {})
        : phrase_(std::move(phrase)), locations_(std::move(locations)) {}

    const std::string& phrase() const { return phrase_; }
    const std::vector<Subject>& locations() const { return locations_; }

private:
    std::string phrase_;
    std::vector<Subject> locations_;
};

// Anything that is a Subject (including your own subclasses).
template <class T>
concept SubjectLike = std::derived_from<std::remove_cvref_t<T>, Subject>;

// The project Claude is working in.
struct Project : Subject {
    Project() : Subject("this project") {}
};
inline const Project this_project;

// A file, relative to the project root. Warns if it does not exist.
struct File : Subject {
    explicit File(const std::string& path) : Subject("the file `" + path + "`") {
        if (!std::filesystem::is_regular_file(path)) detail::warn("File not found: " + path);
    }
};

// A directory, relative to the project root. Warns if it does not exist.
struct Dir : Subject {
    explicit Dir(const std::string& path) : Subject("the directory `" + path + "`") {
        if (!std::filesystem::is_directory(path)) detail::warn("Directory not found: " + path);
    }
};

// A function, optionally pinned to the file that defines it. If you give a
// file, the function name is searched for in it and a warning is raised when
// the text does not appear.
struct Function : Subject {
    explicit Function(const std::string& name, const std::string& in_file = "")
        : Subject(in_file.empty() ? "the function `" + name + "`"
                                  : "the function `" + name + "` in `" + in_file + "`") {
        if (in_file.empty()) return;
        if (!std::filesystem::is_regular_file(in_file)) {
            detail::warn("File not found: " + in_file);
        } else if (detail::read_file(in_file).find(name) == std::string::npos) {
            detail::warn("'" + name + "' does not appear in " + in_file);
        }
    }
};

// ---------------------------------------------------------------------------
// Aspect: a part of a subject -- "the <aspect> of <subject>". It inherits the
// subject's locations. Add your own by subclassing (see project.hpp).
// ---------------------------------------------------------------------------

class Aspect : public Subject {
public:
    Aspect(const std::string& aspect, const Subject& of)
        : Subject("the " + aspect + " of " + of.phrase(), of.locations()) {}
};

struct Purpose : Aspect {
    explicit Purpose(const Subject& of) : Aspect("purpose", of) {}
};
struct Structure : Aspect {
    explicit Structure(const Subject& of) : Aspect("structure", of) {}
};
struct Components : Aspect {
    explicit Components(const Subject& of) : Aspect("main components", of) {}
};
struct Dependencies : Aspect {
    explicit Dependencies(const Subject& of) : Aspect("dependencies", of) {}
};
struct Tests : Aspect {
    explicit Tests(const Subject& of) : Aspect("tests", of) {}
};
struct PublicApi : Aspect {
    explicit PublicApi(const Subject& of) : Aspect("public API", of) {}
};

// ---------------------------------------------------------------------------
// Format: how an answer should be shaped. Use with Action::in().
//     Summarize(this_project).in(Bullets(3))
// ---------------------------------------------------------------------------

class Format {
public:
    explicit Format(std::string phrase) : phrase_(std::move(phrase)) {}
    const std::string& phrase() const { return phrase_; }

private:
    std::string phrase_;
};

struct Bullets : Format {
    explicit Bullets(int n) : Format(std::to_string(n) + (n == 1 ? " bullet point" : " bullet points")) {}
};
struct Sentences : Format {
    explicit Sentences(int n) : Format(std::to_string(n) + (n == 1 ? " sentence" : " sentences")) {}
};

// ---------------------------------------------------------------------------
// Action: a verb applied to one or more subjects. It reads as a command
// ("Read the file `x`.") and, in Prompt::forbid, as a prohibition
// ("Do not read the file `x`."). Define new verbs like the ones below, or
// build one directly: Action("audit", {Subject("the login flow")}).
// ---------------------------------------------------------------------------

class Action {
public:
    Action(std::string verb, std::vector<Subject> objects)
        : verb_(std::move(verb)), objects_(std::move(objects)) {}

    // A copy of this action with an answer format attached.
    Action in(const Format& format) const {
        Action copy = *this;
        copy.format_ = format.phrase();
        return copy;
    }

    const std::vector<Subject>& objects() const { return objects_; }

    std::string command() const { return detail::capitalize(verb_) + rest() + "."; }
    std::string prohibition() const { return "Do not " + verb_ + rest() + "."; }

private:
    std::string rest() const {
        std::vector<std::string> phrases;
        for (const Subject& s : objects_) phrases.push_back(s.phrase());
        std::string out = " " + detail::join(phrases);
        if (!format_.empty()) out += " in " + format_;
        return out;
    }

    std::string verb_;
    std::vector<Subject> objects_;
    std::string format_;
};

struct Read : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Read(const S&... what) : Action("read", {what...}) {}
};
struct List : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit List(const S&... what) : Action("list", {what...}) {}
};
struct Find : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Find(const S&... what) : Action("find", {what...}) {}
};
struct Explain : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Explain(const S&... what) : Action("explain", {what...}) {}
};
struct Summarize : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Summarize(const S&... what) : Action("summarize", {what...}) {}
};
struct Check : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Check(const S&... what) : Action("check", {what...}) {}
};
struct Run : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Run(const S&... what) : Action("run", {what...}) {}
};
struct Modify : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Modify(const S&... what) : Action("modify", {what...}) {}
};
struct Add : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Add(const S&... what) : Action("add", {what...}) {}
};
struct Remove : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Remove(const S&... what) : Action("remove", {what...}) {}
};
struct Fix : Action {
    template <SubjectLike... S>
        requires(sizeof...(S) > 0)
    explicit Fix(const S&... what) : Action("fix", {what...}) {}
};

// ---------------------------------------------------------------------------
// Condition: a state that must hold when the work is finished. Shown as a
// checklist item: "Passing: the tests of this project".
// ---------------------------------------------------------------------------

class Condition {
public:
    Condition(std::string state, Subject subject)
        : state_(std::move(state)), subject_(std::move(subject)) {}

    const Subject& subject() const { return subject_; }
    std::string item() const { return detail::capitalize(state_) + ": " + subject_.phrase(); }

private:
    std::string state_;
    Subject subject_;
};

struct Passing : Condition {
    explicit Passing(const Subject& what) : Condition("passing", what) {}
};
struct Compiling : Condition {
    explicit Compiling(const Subject& what) : Condition("compiling", what) {}
};
struct Unchanged : Condition {
    explicit Unchanged(const Subject& what) : Condition("unchanged", what) {}
};

// ---------------------------------------------------------------------------
// Prompt: builds the message. Every method returns *this so calls can chain.
// ---------------------------------------------------------------------------

class Prompt {
public:
    // What you want done. Required -- emit() fails without one.
    Prompt& goal(const Action& action) {
        goal_ = action;
        return *this;
    }

    // Extra subjects Claude should look at first. Concepts you mention
    // anywhere else are added automatically along with where they live.
    template <SubjectLike... S>
    Prompt& context(const S&... subjects) {
        (context_.push_back(Subject(subjects)), ...);
        return *this;
    }

    // One action, in order. Call it in a loop to generate steps.
    Prompt& step(const Action& action) {
        steps_.push_back(action);
        return *this;
    }

    // Something Claude must not do:  p.forbid(Modify(this_project));
    Prompt& forbid(const Action& action) {
        forbidden_.push_back(action);
        return *this;
    }

    // A state that must hold when Claude is done:  p.accept(Passing(Tests(this_project)));
    Prompt& accept(const Condition& condition) {
        accepted_.push_back(condition);
        return *this;
    }

    // Free text, for what has no concept yet. If you write the same note
    // twice, turn it into a concept in project.hpp instead.
    Prompt& note(std::string text) {
        notes_.push_back(std::move(text));
        return *this;
    }

    // The message as Markdown.
    std::string render() const {
        std::ostringstream out;
        out << "# Goal\n" << (goal_ ? goal_->command() : std::string()) << "\n";

        const std::vector<std::string> looks = look_at_first();
        if (!looks.empty()) {
            out << "\n## Look at first\n";
            for (const std::string& line : looks) out << "- " << detail::capitalize(line) << '\n';
        }
        if (!steps_.empty()) {
            out << "\n## Steps, in order\n";
            for (std::size_t i = 0; i < steps_.size(); ++i) {
                out << (i + 1) << ". " << detail::indent_continuation(steps_[i].command(), 3) << '\n';
            }
        }
        if (!forbidden_.empty()) {
            out << "\n## Constraints\n";
            for (const Action& a : forbidden_) out << "- " << a.prohibition() << '\n';
        }
        if (!accepted_.empty()) {
            out << "\n## Done when\n";
            for (const Condition& c : accepted_) out << "- " << c.item() << '\n';
        }
        if (!notes_.empty()) {
            out << "\n## Notes\n";
            for (const std::string& n : notes_) out << "- " << detail::indent_continuation(n, 2) << '\n';
        }
        return out.str();
    }

    // Print the message to stdout. Use as the last line of main():
    //     return p.emit();
    // The return value is main's exit code: 0 = fine, 1 = nothing to send.
    int emit() const {
        if (!goal_) {
            std::cerr << "error: this prompt has no goal. Call p.goal(Explain(...)).\n";
            return 1;
        }
        std::cout << render();
        return 0;
    }

private:
    // "the config parser (the file `src/config.cpp`)" -- a subject and where it lives.
    static std::string describe(const Subject& s) {
        if (s.locations().empty()) return s.phrase();
        std::vector<std::string> where;
        for (const Subject& l : s.locations()) where.push_back(l.phrase());
        return s.phrase() + " (" + detail::join(where) + ")";
    }

    // Explicit context first, then every mentioned concept that knows where it lives.
    std::vector<std::string> look_at_first() const {
        std::vector<std::string> lines;
        auto add = [&lines](const Subject& s) {
            const std::string line = describe(s);
            for (const std::string& seen : lines) if (seen == line) return;
            lines.push_back(line);
        };
        for (const Subject& s : context_) add(s);
        auto mentioned = [&add](const Action& a) {
            for (const Subject& s : a.objects()) if (!s.locations().empty()) add(s);
        };
        if (goal_) mentioned(*goal_);
        for (const Action& a : steps_) mentioned(a);
        for (const Action& a : forbidden_) mentioned(a);
        for (const Condition& c : accepted_) if (!c.subject().locations().empty()) add(c.subject());
        return lines;
    }

    std::optional<Action> goal_;
    std::vector<Subject> context_;
    std::vector<Action> steps_;
    std::vector<Action> forbidden_;
    std::vector<Condition> accepted_;
    std::vector<std::string> notes_;
};

}  // namespace claude
