export type Language = 'cpp' | 'python';

export interface LanguageInfo {
  id: Language;
  label: string;
  /** The file the user edits. */
  source: string;
  /** The bundled vocabulary (where all the English lives). */
  vocabulary: string;
  /** The user's own concepts. */
  concepts: string;
  /** Files with this extension in .claude-cpp/ are part of the prompt program: saving one reruns it. */
  moduleExt: string;
  /** Status-line wording: C++ is compiled, Python is just run. */
  progress: string;
  done: string;
}

export const LANGUAGES: Record<Language, LanguageInfo> = {
  cpp: {
    id: 'cpp',
    label: 'C++',
    source: 'instructions.cpp',
    vocabulary: 'claude.hpp',
    concepts: 'project.hpp',
    moduleExt: '.hpp',
    progress: 'Compiling…',
    done: 'Compiled',
  },
  python: {
    id: 'python',
    label: 'Python',
    source: 'instructions.py',
    vocabulary: 'claude.py',
    concepts: 'project.py',
    moduleExt: '.py',
    progress: 'Running…',
    done: 'Ran',
  },
};

export const DEFAULT_LANGUAGE: Language = 'cpp';

export function isLanguage(value: unknown): value is Language {
  return value === 'cpp' || value === 'python';
}
