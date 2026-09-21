// project.hpp  --  the vocabulary of THIS project. Yours: never overwritten.
//
// claude.hpp knows generic things (files, tests, "read", "modify"). Teach it
// the things that are specific to your project here, once, and then use them
// by name in instructions.cpp. Saving this file recompiles instructions.cpp.
//
// A thing, and where it lives. Claude is pointed at those places every time
// you mention it:
//
//     struct ConfigParser : Subject {
//         ConfigParser()
//             : Subject("the config parser",
//                       {File("src/config.cpp"), Function("parse", "src/config.cpp")}) {}
//     };
//
//     p.step(Read(ConfigParser()));
//     p.forbid(Modify(PublicApi(ConfigParser())));
//
// A part of a thing (an Aspect, like Purpose or Tests):
//
//     struct Validation : Aspect {
//         explicit Validation(const Subject& of) : Aspect("input validation", of) {}
//     };
//
//     p.step(Check(Validation(ConfigParser())));
//
// A verb:
//
//     struct Deprecate : Action {
//         template <SubjectLike... S>
//             requires(sizeof...(S) > 0)
//         explicit Deprecate(const S&... what) : Action("deprecate", {what...}) {}
//     };
//
// A done-when:
//
//     struct Documented : Condition {
//         explicit Documented(const Subject& what) : Condition("documented", what) {}
//     };

#pragma once

#include "claude.hpp"

namespace claude {

// Your concepts go here.

}  // namespace claude
