import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CompilerDiagnostic {
  file: string;
  line: number; // 1-based
  column: number; // 1-based
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface BuildOptions {
  compiler: string;
  standard: string;
  extraFlags: string[];
  source: string; // absolute path to instructions.cpp
  buildDir: string; // where the binary goes
  cwd: string; // working directory for the run (project root)
  signal?: AbortSignal;
  compileTimeoutMs?: number;
  runTimeoutMs?: number;
}

export interface BuildResult {
  ok: boolean;
  stage: 'compile' | 'run' | 'done';
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
  opts: { cwd: string; timeout: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 16 * 1024 * 1024, signal: opts.signal, encoding: 'utf8' },
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

export async function buildAndRun(opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const done = (r: Omit<BuildResult, 'durationMs'>): BuildResult => ({ ...r, durationMs: Date.now() - started });
  const empty = { prompt: '', runOutput: '', compilerOutput: '', diagnostics: [] as CompilerDiagnostic[] };

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

  const compilerOutput = compiled.stderr + compiled.stdout;
  const diagnostics = parseDiagnostics(compilerOutput);
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

  const ran = await run(binary, [], { cwd: opts.cwd, timeout: opts.runTimeoutMs ?? 10_000, signal: opts.signal });
  if (ran.aborted) return done({ ...empty, ok: false, stage: 'run', compilerOutput, diagnostics, message: 'Cancelled', aborted: true });

  const base = { prompt: ran.stdout, runOutput: ran.stderr, compilerOutput, diagnostics };
  if (ran.spawnError) {
    return done({ ...base, ok: false, stage: 'run', message: `Could not run the compiled program: ${ran.spawnError.message}` });
  }
  if (ran.timedOut) {
    return done({ ...base, ok: false, stage: 'run', message: `The program ran longer than ${(opts.runTimeoutMs ?? 10_000) / 1000} seconds and was stopped (infinite loop?).` });
  }
  if (ran.code !== 0) {
    return done({
      ...base,
      ok: false,
      stage: 'run',
      message: ran.code === null ? 'The program crashed.' : `The program exited with code ${ran.code}.`,
    });
  }
  if (ran.stdout.trim() === '') {
    return done({ ...base, ok: false, stage: 'run', message: 'The program printed nothing, so there is nothing to send. Did you call p.emit()?' });
  }
  return done({ ...base, ok: true, stage: 'done', message: 'Compiled.' });
}
