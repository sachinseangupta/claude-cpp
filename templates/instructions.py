# instructions.py  --  your message to Claude, written in Python.
#
#   1. Edit this file.
#   2. Save (Cmd+S). It is run; the panel on the right shows the text it
#      produced.
#   3. When the preview looks right, press "Send to Claude"
#      (or Cmd+Option+Enter).
#
# You do not write English here. You combine concepts -- Subjects (things),
# Actions (verbs), Conditions (done-when) -- and claude.py words them.
# Your own concepts for this project go in project.py.
#
# Errors show up here as red squiggles and in the panel. Fixing them is part
# of the job -- that is the point of this tool.

from project import *

p = Prompt()

p.goal(Explain(Purpose(this_project), Structure(this_project)))

# Ordinary Python builds the steps: a list and a for loop.
# Each of these warns (in the panel) if the path does not exist.
to_read = [File("README.md"), Dir("src")]
for thing in to_read:
    p.step(Read(thing))
p.step(List(Components(this_project)))
p.step(Summarize(this_project).in_(Bullets(3)))

p.forbid(Modify(this_project))

p.emit()
