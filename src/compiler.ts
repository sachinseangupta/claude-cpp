import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { augmentedEnv } from './claude';
import { LANGUAGES } from './language';

export interface CompilerDiagnostic {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  severity: 'error' | 'warning' | 'note';
  message: string;
}

interface CommonOptions {
  source: string; // absolute path to instructions.cpp / instructions.py
  cwd: string; // working directory for the run (project root)
  signal?: AbortSignal;
  runTimeoutMs?: number;
}

/** instructions.cpp: compiled, then the binary is run. */
export interface CppBuildOptions extends CommonOptions {
  language?: 'cpp';
  compiler: string;
  standard: string;
  extraFlags: string[];
  buildDir: string; // where the binary goes
  compileTimeoutMs?: number;
}

/** instructions.py: run directly by the interpreter (there is no compile step). */
export interface PythonRunOptions extends CommonOptions {
  language: 'python';
  python: string; // interpreter command or path
}

export type BuildOptions = CppBuildOptions | PythonRunOptions;

export interface BuildResult {
  ok: boolean;
  stage: 'compile' | 'run' | 'done'; // for Python, a syntax error counts as 'compile'
  prompt: string; // stdout of the program
  runOutput: string; // stderr of the program (warnings, errors)
  compilerOutput: string;
  diagnostics: CompilerDiagnostic[];
  message: string; // one-line summary for the UI
  durationMs: number;
  aborted?: boolean;
}

const DIAG_RE = /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;

export function parseDiagnostics(output: string): CompilerDiagnostic[] {
  const found: CompilerDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    found.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === 'warning' ? 'warning' : m[4] === 'note' ? 'note' : 'error',
      message: m[5],
    });
  }
  return found;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
  timedOut: boolean;
  aborted: boolean;
}

function run(
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 16 * 1024 * 1024, signal: opts.signal, encoding: 'utf8', env: opts.env },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const aborted = !!opts.signal?.aborted;
        if (!e) return resolve({ code: 0, stdout, stderr, timedOut: false, aborted });
        const spawnFailed = typeof e.code === 'string';
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          stdout,
          stderr,
          spawnError: spawnFailed && !aborted ? e : undefined,
          timedOut: !!e.killed && !aborted,
          aborted,
        });
      },
    );
  });
}

const PY_FRAME_RE = /^\s*File "(.+)", line (\d+)/;
const PY_SYNTAX_ERROR_RE = /^(SyntaxError|IndentationError|TabError)\b/;

export interface PythonError {
  message: string; // the exception line, e.g. "TypeError: Read() needs a concept ..."
  syntax: boolean; // it failed before running anything
  diagnostics: CompilerDiagnostic[];
}

/**
 * Read a Python traceback. The error is placed on the innermost frame that is in the user's own
 * files (the project dir, minus the bundled vocabulary), so a mistake passed to Read(...) is
 * flagged in instructions.py rather than deep inside claude.py. Returns undefined when stderr has
 * no traceback (e.g. the program called sys.exit).
 */
export function parsePythonError(stderr: string, projectDir: string, vocabulary: string): PythonError | undefined {
  const lines = stderr.split('\n');
  if (!lines.some((l) => PY_FRAME_RE.test(l))) return undefined;

  // The exception line is the last one that is not indented (frames, source and carets all are).
  const message = [...lines].reverse().find((l) => l.trim() !== '' && !/^\s/.test(l))?.trim() ?? '';

  // realpath, not just resolve: Python's importer reports module files by their real path (e.g. resolving
  // macOS's /var -> /private/var), while the top-level script keeps whatever path it was launched with.
  const realish = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const dir = realish(projectDir) + path.sep;
  let where: { file: string; line: number } | undefined;
  for (const l of lines) {
    const m = PY_FRAME_RE.exec(l);
    if (!m) continue;
    const file = realish(m[1]);
    if (file.startsWith(dir) && path.basename(file) !== vocabulary) where = { file, line: Number(m[2]) };
  }
  return {
    message,
    syntax: PY_SYNTAX_ERROR_RE.test(message),
    diagnostics: where ? [{ file: where.file, line: where.line, column: 1, severity: 'error', message }] : [],
  };
}

/** What differs between languages once there is a program to run. */
interface Program {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  spawnFailure(e: NodeJS.ErrnoException): string;
  /** Turn a failed run's stderr into a message, diagnostics and stage. */
  failure(stderr: string, code: number | null): { message: string; diagnostics: CompilerDiagnostic[]; stage: BuildResult['stage'] } | undefined;
}

export async function buildAndRun(opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const done = (r: Omit<BuildResult, 'durationMs'>): BuildResult => ({ ...r, durationMs: Date.now() - started });
  const empty = { prompt: '', runOutput: '', compilerOutput: '', diagnostics: [] as CompilerDiagnostic[] };

  let compilerOutput = '';
  let diagnostics: CompilerDiagnostic[] = [];
  let program: Program;

  if (opts.language === 'python') {
    const python = opts.python;
    const projectDir = path.dirname(opts.source);
    program = {
      file: python,
      // -B: never leave __pycache__ behind. The script's own directory is on sys.path, so `import project` works.
      args: ['-B', opts.source],
      env: { ...augmentedEnv(), PYTHONUTF8: '1' },
      spawnFailure: (e) =>
        e.code === 'ENOENT'
          ? `Python "${python}" was not found. Install Python 3 or set claudeCpp.python.`
          : `Could not start Python "${python}": ${e.message}`,
      failure: (stderr) => {
        const err = parsePythonError(stderr, projectDir, LANGUAGES.python.vocabulary);
        return err && { message: err.message, diagnostics: err.diagnostics, stage: err.syntax ? 'compile' : 'run' };
      },
    };
  } else {
    fs.mkdirSync(opts.buildDir, { recursive: true });
    const binary = path.join(opts.buildDir, 'instructions');
    fs.rmSync(binary, { force: true }); // never run a stale binary after a failed compile

    const sourceDir = path.dirname(opts.source);
    const compileArgs = [
      `-std=${opts.standard}`,
      '-Wall',
      '-Wextra',
      '-fno-color-diagnostics',
      '-I',
      sourceDir,
      ...opts.extraFlags,
      opts.source,
      '-o',
      binary,
    ];

    const compiled = await run(opts.compiler, compileArgs, {
      cwd: opts.cwd,
      timeout: opts.compileTimeoutMs ?? 60_000,
      signal: opts.signal,
    });

    if (compiled.aborted) return done({ ...empty, ok: false, stage: 'compile', message: 'Cancelled', aborted: true });
    if (compiled.spawnError) {
      const why =
        compiled.spawnError.code === 'ENOENT'
          ? `Compiler "${opts.compiler}" was not found. Install the Xcode Command Line Tools ("xcode-select --install") or set claudeCpp.compiler.`
          : `Could not start compiler "${opts.compiler}": ${compiled.spawnError.message}`;
      return done({ ...empty, ok: false, stage: 'compile', message: why, compilerOutput: why });
    }

    compilerOutput = compiled.stderr + compiled.stdout;
    diagnostics = parseDiagnostics(compilerOutput);
    if (compiled.timedOut) {
      return done({ ...empty, ok: false, stage: 'compile', compilerOutput, diagnostics, message: 'Compilation timed out.' });
    }
    if (compiled.code !== 0) {
      const errors = diagnostics.filter((d) => d.severity === 'error').length;
      return done({
        ...empty,
        ok: false,
        stage: 'compile',
        compilerOutput,
        diagnostics,
        message: errors ? `Compilation failed: ${errors} error${errors === 1 ? '' : 's'}.` : 'Compilation failed.',
      });
    }

    program = {
      file: binary,
      args: [],
      spawnFailure: (e) => `Could not run the compiled program: ${e.message}`,
      failure: () => undefined,
    };
  }

  const timeoutMs = opts.runTimeoutMs ?? 10_000;
  const ran = await run(program.file, program.args, { cwd: opts.cwd, timeout: timeoutMs, signal: opts.signal, env: program.env });
  if (ran.aborted) return done({ ...empty, ok: false, stage: 'run', compilerOutput, diagnostics, message: 'Cancelled', aborted: true });

  const base = { prompt: ran.stdout, runOutput: ran.stderr, compilerOutput, diagnostics };
  if (ran.spawnError) {
    return done({ ...base, ok: false, stage: 'run', message: program.spawnFailure(ran.spawnError) });
  }
  if (ran.timedOut) {
    return done({ ...base, ok: false, stage: 'run', message: `The program ran longer than ${timeoutMs / 1000} seconds and was stopped (infinite loop?).` });
  }
  if (ran.code !== 0) {
    const failure = program.failure(ran.stderr, ran.code);
    return done({
      ...base,
      diagnostics: failure ? [...diagnostics, ...failure.diagnostics] : diagnostics,
      ok: false,
      stage: failure?.stage ?? 'run',
      message: failure?.message || (ran.code === null ? 'The program crashed.' : `The program exited with code ${ran.code}.`),
    });
  }
  if (ran.stdout.trim() === '') {
    return done({ ...base, ok: false, stage: 'run', message: 'The program printed nothing, so there is nothing to send. Did you call p.emit()?' });
  }
  return done({ ...base, ok: true, stage: 'done', message: `${LANGUAGES[opts.language ?? 'cpp'].done}.` });
}
