# project.py  --  the vocabulary of THIS project. Yours: never overwritten.
#
# claude.py knows generic things (files, tests, "read", "modify"). Teach it
# the things that are specific to your project here, once, and then use them
# by name in instructions.py. Saving this file reruns instructions.py.
#
# A thing, and where it lives. Claude is pointed at those places every time
# you mention it:
#
#     class ConfigParser(Subject):
#         def __init__(self):
#             super().__init__("the config parser",
#                              [File("src/config.py"), Function("parse", "src/config.py")])
#
#     p.step(Read(ConfigParser()))
#     p.forbid(Modify(PublicApi(ConfigParser())))
#
# A part of a thing (an Aspect, like Purpose or Tests):
#
#     class Validation(Aspect):
#         def __init__(self, of):
#             super().__init__("input validation", of)
#
#     p.step(Check(Validation(ConfigParser())))
#
# A verb:
#
#     class Deprecate(Action):
#         def __init__(self, *what):
#             super().__init__("deprecate", *what)
#
# A done-when:
#
#     class Documented(Condition):
#         def __init__(self, what):
#             super().__init__("documented", what)

from claude import *

# Your concepts go here.
