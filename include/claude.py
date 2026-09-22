"""claude.py  --  the vocabulary for writing instructions to Claude in Python.

You write a normal Python program. When it runs, whatever it prints to stdout
becomes the message sent to Claude. Instead of writing English, you combine
concepts (classes) and let this module do the wording:

    p = Prompt()
    p.goal(Explain(Purpose(this_project)))
    p.step(Read(File("README.md")))
    p.forbid(Modify(this_project))
    p.emit()

  Subject    a thing:         this_project, File, Dir, Function, or your own
  Aspect     part of a thing: Purpose(x), Structure(x), Tests(x), PublicApi(x)
  Action     a verb + things: Read(x), List(x), Modify(x), Summarize(x).in_(Bullets(3))
  Condition  a done-when:     Passing(x), Compiling(x), Unchanged(x)

The English lives in this file, once. Your own concepts go in project.py.
Feel free to read and change this file -- it is ordinary Python.
(Command palette: "Claude C++: Reset claude.hpp / claude.py" restores the bundled copy.)

This is the same vocabulary as claude.hpp, so the same program written in either
language sends the same message. The one spelling difference: `in` is a Python
keyword, so the answer-format method is `.in_(...)`.
"""

from __future__ import annotations

import copy
import os
import sys

CLAUDE_PY_HEADER_VERSION = 1

__all__ = [
    # subjects
    "Subject", "Project", "this_project", "File", "Dir", "Function",
    # aspects
    "Aspect", "Purpose", "Structure", "Components", "Dependencies", "Tests", "PublicApi",
    # formats
    "Format", "Bullets", "Sentences",
    # actions
    "Action", "Read", "List", "Find", "Explain", "Summarize", "Check", "Run", "Modify", "Add", "Remove", "Fix",
    # conditions
    "Condition", "Passing", "Compiling", "Unchanged",
    # the message
    "Prompt", "PromptError",
]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# Warnings go to stderr, which the panel shows next to the compiled prompt.
def _warn(message):
    print("warning: " + message, file=sys.stderr)


def _read_file(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _capitalize(text):
    return text[:1].upper() + text[1:]


# ["a"] -> "a"   ["a", "b"] -> "a and b"   ["a", "b", "c"] -> "a, b and c"
def _join(items):
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


# "a\nb" -> "a\n   b" so multi-line text stays inside its list item.
def _indent_continuation(text, spaces):
    return text.replace("\n", "\n" + " " * spaces)


def _describe(value):
    if isinstance(value, str):
        return "the text %r. Instructions are built from concepts, not raw text (use p.note() for free text)" % value
    return "a value of type %s" % type(value).__name__


def _expect(value, kind, where, wanted):
    """Raise a TypeError that says what was expected where, instead of failing deep inside the module."""
    if not isinstance(value, kind):
        raise TypeError("%s needs %s, but got %s." % (where, wanted, _describe(value)))
    return value


_A_CONCEPT = 'a concept such as File("a.py") or this_project'


class PromptError(Exception):
    """The prompt cannot be sent as written (for example, it has no goal)."""


# ---------------------------------------------------------------------------
# Subject: a thing an instruction can be about.
#
# A subject is a noun phrase, plus optionally the places it lives. Claude is
# pointed at those places whenever the subject is mentioned, so defining a
# concept once (in project.py) means you never repeat where it is.
# ---------------------------------------------------------------------------

class Subject:
    def __init__(self, phrase, locations=()):
        where = type(self).__name__ + "()"
        if not isinstance(phrase, str):
            raise TypeError("%s needs a phrase such as \"the config parser\", but got %s." % (where, _describe(phrase)))
        self._phrase = phrase
        self._locations = tuple(_expect(loc, Subject, where, "locations that are concepts such as File(...)") for loc in locations)

    @property
    def phrase(self):
        return self._phrase

    @property
    def locations(self):
        return self._locations


# The project Claude is working in.
class Project(Subject):
    def __init__(self):
        super().__init__("this project")


this_project = Project()


# A file, relative to the project root. Warns if it does not exist.
class File(Subject):
    def __init__(self, path):
        super().__init__("the file `" + path + "`")
        if not os.path.isfile(path):
            _warn("File not found: " + path)


# A directory, relative to the project root. Warns if it does not exist.
class Dir(Subject):
    def __init__(self, path):
        super().__init__("the directory `" + path + "`")
        if not os.path.isdir(path):
            _warn("Directory not found: " + path)


# A function, optionally pinned to the file that defines it. If you give a
# file, the function name is searched for in it and a warning is raised when
# the text does not appear.
class Function(Subject):
    def __init__(self, name, in_file=""):
        if in_file:
            super().__init__("the function `" + name + "` in `" + in_file + "`")
        else:
            super().__init__("the function `" + name + "`")
        if not in_file:
            return
        if not os.path.isfile(in_file):
            _warn("File not found: " + in_file)
        elif name not in _read_file(in_file):
            _warn("'" + name + "' does not appear in " + in_file)


# ---------------------------------------------------------------------------
# Aspect: a part of a subject -- "the <aspect> of <subject>". It inherits the
# subject's locations. Add your own by subclassing (see project.py).
# ---------------------------------------------------------------------------

class Aspect(Subject):
    def __init__(self, aspect, of):
        _expect(of, Subject, type(self).__name__ + "()", _A_CONCEPT)
        super().__init__("the " + aspect + " of " + of.phrase, of.locations)


class Purpose(Aspect):
    def __init__(self, of):
        super().__init__("purpose", of)


class Structure(Aspect):
    def __init__(self, of):
        super().__init__("structure", of)


class Components(Aspect):
    def __init__(self, of):
        super().__init__("main components", of)


class Dependencies(Aspect):
    def __init__(self, of):
        super().__init__("dependencies", of)


class Tests(Aspect):
    def __init__(self, of):
        super().__init__("tests", of)


class PublicApi(Aspect):
    def __init__(self, of):
        super().__init__("public API", of)


# ---------------------------------------------------------------------------
# Format: how an answer should be shaped. Use with Action.in_():
#     Summarize(this_project).in_(Bullets(3))
# ---------------------------------------------------------------------------

class Format:
    def __init__(self, phrase):
        self._phrase = phrase

    @property
    def phrase(self):
        return self._phrase


def _count(n, noun):
    if not isinstance(n, int) or isinstance(n, bool):
        raise TypeError("%s needs a whole number, but got %s." % (noun.capitalize(), _describe(n)))
    return "%d %s%s" % (n, noun, "" if n == 1 else "s")


class Bullets(Format):
    def __init__(self, n):
        super().__init__(_count(n, "bullet point"))


class Sentences(Format):
    def __init__(self, n):
        super().__init__(_count(n, "sentence"))


# ---------------------------------------------------------------------------
# Action: a verb applied to one or more subjects. It reads as a command
# ("Read the file `x`.") and, in Prompt.forbid, as a prohibition
# ("Do not read the file `x`."). Define new verbs like the ones below, or
# build one directly: Action("audit", Subject("the login flow")).
# ---------------------------------------------------------------------------

class Action:
    def __init__(self, verb, *objects):
        where = type(self).__name__ + "()"
        if not objects:
            raise TypeError("%s needs at least one thing to act on, for example %s(%s)." % (where, type(self).__name__, 'File("a.py")'))
        self._verb = verb
        self._objects = tuple(_expect(o, Subject, where, _A_CONCEPT) for o in objects)
        self._format = ""

    # A copy of this action with an answer format attached.
    def in_(self, format):
        _expect(format, Format, type(self).__name__ + ".in_()", "a format such as Bullets(3)")
        clone = copy.copy(self)
        clone._format = format.phrase
        return clone

    @property
    def objects(self):
        return self._objects

    def command(self):
        return _capitalize(self._verb) + self._rest() + "."

    def prohibition(self):
        return "Do not " + self._verb + self._rest() + "."

    def _rest(self):
        out = " " + _join([s.phrase for s in self._objects])
        if self._format:
            out += " in " + self._format
        return out


class Read(Action):
    def __init__(self, *what):
        super().__init__("read", *what)


class List(Action):
    def __init__(self, *what):
        super().__init__("list", *what)


class Find(Action):
    def __init__(self, *what):
        super().__init__("find", *what)


class Explain(Action):
    def __init__(self, *what):
        super().__init__("explain", *what)


class Summarize(Action):
    def __init__(self, *what):
        super().__init__("summarize", *what)


class Check(Action):
    def __init__(self, *what):
        super().__init__("check", *what)


class Run(Action):
    def __init__(self, *what):
        super().__init__("run", *what)


class Modify(Action):
    def __init__(self, *what):
        super().__init__("modify", *what)


class Add(Action):
    def __init__(self, *what):
        super().__init__("add", *what)


class Remove(Action):
    def __init__(self, *what):
        super().__init__("remove", *what)


class Fix(Action):
    def __init__(self, *what):
        super().__init__("fix", *what)


# ---------------------------------------------------------------------------
# Condition: a state that must hold when the work is finished. Shown as a
# checklist item: "Passing: the tests of this project".
# ---------------------------------------------------------------------------

class Condition:
    def __init__(self, state, subject):
        _expect(subject, Subject, type(self).__name__ + "()", _A_CONCEPT)
        self._state = state
        self._subject = subject

    @property
    def subject(self):
        return self._subject

    def item(self):
        return _capitalize(self._state) + ": " + self._subject.phrase


class Passing(Condition):
    def __init__(self, what):
        super().__init__("passing", what)


class Compiling(Condition):
    def __init__(self, what):
        super().__init__("compiling", what)


class Unchanged(Condition):
    def __init__(self, what):
        super().__init__("unchanged", what)


# ---------------------------------------------------------------------------
# Prompt: builds the message. Every method returns self so calls can chain.
# ---------------------------------------------------------------------------

class Prompt:
    def __init__(self):
        self._goal = None
        self._context = []
        self._steps = []
        self._forbidden = []
        self._accepted = []
        self._notes = []

    # What you want done. Required -- emit() fails without one.
    def goal(self, action):
        self._goal = _expect(action, Action, "Prompt.goal()", 'an action such as Explain(this_project)')
        return self

    # Extra subjects Claude should look at first. Concepts you mention
    # anywhere else are added automatically along with where they live.
    def context(self, *subjects):
        self._context.extend(_expect(s, Subject, "Prompt.context()", _A_CONCEPT) for s in subjects)
        return self

    # One action, in order. Call it in a loop to generate steps.
    def step(self, action):
        self._steps.append(_expect(action, Action, "Prompt.step()", 'an action such as Read(File("a.py"))'))
        return self

    # Something Claude must not do:  p.forbid(Modify(this_project))
    def forbid(self, action):
        self._forbidden.append(_expect(action, Action, "Prompt.forbid()", 'an action such as Modify(this_project)'))
        return self

    # A state that must hold when Claude is done:  p.accept(Passing(Tests(this_project)))
    def accept(self, condition):
        self._accepted.append(_expect(condition, Condition, "Prompt.accept()", 'a condition such as Passing(Tests(this_project))'))
        return self

    # Free text, for what has no concept yet. If you write the same note
    # twice, turn it into a concept in project.py instead.
    def note(self, text):
        if not isinstance(text, str):
            raise TypeError("Prompt.note() needs text, but got %s." % _describe(text))
        self._notes.append(text)
        return self

    # The message as Markdown.
    def render(self):
        out = ["# Goal\n", (self._goal.command() if self._goal else "") + "\n"]

        looks = self._look_at_first()
        if looks:
            out.append("\n## Look at first\n")
            out.extend("- " + _capitalize(line) + "\n" for line in looks)
        if self._steps:
            out.append("\n## Steps, in order\n")
            out.extend("%d. %s\n" % (i, _indent_continuation(a.command(), 3)) for i, a in enumerate(self._steps, 1))
        if self._forbidden:
            out.append("\n## Constraints\n")
            out.extend("- " + a.prohibition() + "\n" for a in self._forbidden)
        if self._accepted:
            out.append("\n## Done when\n")
            out.extend("- " + c.item() + "\n" for c in self._accepted)
        if self._notes:
            out.append("\n## Notes\n")
            out.extend("- " + _indent_continuation(n, 2) + "\n" for n in self._notes)
        return "".join(out)

    # Print the message to stdout. Call it last:
    #     p.emit()
    def emit(self):
        if self._goal is None:
            raise PromptError("this prompt has no goal. Call p.goal(Explain(...)).")
        sys.stdout.write(self.render())
        return 0

    # "the config parser (the file `src/config.cpp`)" -- a subject and where it lives.
    @staticmethod
    def _locate(subject):
        if not subject.locations:
            return subject.phrase
        return subject.phrase + " (" + _join([loc.phrase for loc in subject.locations]) + ")"

    # Explicit context first, then every mentioned concept that knows where it lives.
    def _look_at_first(self):
        lines = []

        def add(subject):
            line = self._locate(subject)
            if line not in lines:
                lines.append(line)

        def mentioned(action):
            for subject in action.objects:
                if subject.locations:
                    add(subject)

        for subject in self._context:
            add(subject)
        if self._goal:
            mentioned(self._goal)
        for action in self._steps:
            mentioned(action)
        for action in self._forbidden:
            mentioned(action)
        for condition in self._accepted:
            if condition.subject.locations:
                add(condition.subject)
        return lines
