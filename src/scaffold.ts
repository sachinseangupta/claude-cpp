import * as fs from 'node:fs';
import * as path from 'node:path';
import { Language, LANGUAGES } from './language';

export const WORK_DIR = '.claude-cpp';

export interface Scaffold {
  language: Language;
  dir: string;
  source: string;
  vocabulary: string;
  buildDir: string;
  createdSource: boolean;
}

/**
 * Make sure the project's own .gitignore ignores .claude-cpp/. Only touches projects that use git
 * (an existing .gitignore, or a .git directory). Any line that already mentions .claude-cpp -- an
 * ignore or a `!.claude-cpp/` negation -- is taken as the user's decision and left alone.
 * Returns true if .gitignore was written.
 */
export function ensureGitignored(root: string): boolean {
  const file = path.join(root, '.gitignore');
  const exists = fs.existsSync(file);
  if (!exists && !fs.existsSync(path.join(root, '.git'))) return false;

  const current = exists ? fs.readFileSync(file, 'utf8') : '';
  const decided = current.split(/\r?\n/).some((line) => !line.trim().startsWith('#') && line.includes(WORK_DIR));
  if (decided) return false;

  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${current}${separator}${WORK_DIR}/\n`);
  return true;
}

/**
 * Create <root>/.claude-cpp/ with the starter files for one language. Never overwrites existing files.
 * The languages live side by side, so switching to one for the first time only adds its files.
 */
export function ensureScaffold(root: string, extensionRoot: string, language: Language = 'cpp'): Scaffold {
  const lang = LANGUAGES[language];
  const dir = path.join(root, WORK_DIR);
  const source = path.join(dir, lang.source);
  const vocabulary = path.join(dir, lang.vocabulary);
  const buildDir = path.join(dir, 'build');
  fs.mkdirSync(dir, { recursive: true });

  let createdSource = false;
  if (!fs.existsSync(source)) {
    fs.copyFileSync(path.join(extensionRoot, 'templates', lang.source), source);
    createdSource = true;
  }
  if (!fs.existsSync(vocabulary)) fs.copyFileSync(path.join(extensionRoot, 'include', lang.vocabulary), vocabulary);
  const concepts = path.join(dir, lang.concepts);
  if (!fs.existsSync(concepts)) fs.copyFileSync(path.join(extensionRoot, 'templates', lang.concepts), concepts);

  // Ignore the compiled binary (and Python's bytecode) even if the project's own .gitignore is not used or gets edited.
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'build/\n__pycache__/\n');
  ensureGitignored(root);

  // Helps clangd / other tooling find the header and language standard.
  if (language === 'cpp') {
    const flags = path.join(dir, 'compile_flags.txt');
    if (!fs.existsSync(flags)) fs.writeFileSync(flags, '-std=c++20\n-I.\n');
  }

  return { language, dir, source, vocabulary, buildDir, createdSource };
}

export function resetVocabulary(root: string, extensionRoot: string, language: Language = 'cpp'): string {
  const name = LANGUAGES[language].vocabulary;
  const target = path.join(root, WORK_DIR, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, 'include', name), target);
  return target;
}
