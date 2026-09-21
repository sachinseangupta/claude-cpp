import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORK_DIR = '.claude-cpp';
export const SOURCE_NAME = 'instructions.cpp';
export const HEADER_NAME = 'claude.hpp';
export const CONCEPTS_NAME = 'project.hpp';

export interface Scaffold {
  dir: string;
  source: string;
  header: string;
  buildDir: string;
  createdSource: boolean;
}

/** Create <root>/.claude-cpp/ with the starter files. Never overwrites existing files. */
export function ensureScaffold(root: string, extensionRoot: string): Scaffold {
  const dir = path.join(root, WORK_DIR);
  const source = path.join(dir, SOURCE_NAME);
  const header = path.join(dir, HEADER_NAME);
  const buildDir = path.join(dir, 'build');
  fs.mkdirSync(dir, { recursive: true });

  let createdSource = false;
  if (!fs.existsSync(source)) {
    fs.copyFileSync(path.join(extensionRoot, 'templates', SOURCE_NAME), source);
    createdSource = true;
  }
  if (!fs.existsSync(header)) fs.copyFileSync(path.join(extensionRoot, 'include', HEADER_NAME), header);
  const concepts = path.join(dir, CONCEPTS_NAME);
  if (!fs.existsSync(concepts)) fs.copyFileSync(path.join(extensionRoot, 'templates', CONCEPTS_NAME), concepts);

  // Ignore the compiled binary; keep instructions.cpp and claude.hpp trackable.
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'build/\n');

  // Helps clangd / other tooling find the header and language standard.
  const flags = path.join(dir, 'compile_flags.txt');
  if (!fs.existsSync(flags)) fs.writeFileSync(flags, '-std=c++20\n-I.\n');

  return { dir, source, header, buildDir, createdSource };
}

export function resetHeader(root: string, extensionRoot: string): string {
  const target = path.join(root, WORK_DIR, HEADER_NAME);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, 'include', HEADER_NAME), target);
  return target;
}
