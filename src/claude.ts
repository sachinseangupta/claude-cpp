import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'tool-error'; text: string }
  | {
      kind: 'result';
      ok: boolean;
      text: string;
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
      denied: { tool: string; summary: string }[];
    }
  | { kind: 'error'; message: string };

export interface ClaudeRunOptions {
  binary: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  permissionMode: string;
  allowedTools: string[];
  model?: string;
  signal?: AbortSignal;
  onEvent: (e: ClaudeEvent) => void;
}

export function augmentedEnv(): NodeJS.ProcessEnv {
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const existing = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return { ...process.env, PATH: [...existing, ...extra.filter((p) => !existing.includes(p))].join(path.delimiter) };
}

/** VS Code launched from the Dock has a minimal PATH, so look in the usual places too. */
export async function resolveClaudeBinary(configured: string): Promise<string | undefined> {
  if (configured.trim()) return configured.trim();
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const child = spawn(shell, ['-lc', 'command -v claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(undefined));
    child.on('close', () => resolve(out.trim().split('\n').pop() || undefined));
  });
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt'];
  for (const k of pick) {
    const v = i[k];
    if (typeof v === 'string' && v) return v.length > 160 ? v.slice(0, 157) + '…' : v;
  }
  return '';
}

/** Translate one line of `claude -p --output-format stream-json --verbose` into UI events. */
export function parseStreamLine(line: string): ClaudeEvent[] {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  const events: ClaudeEvent[] = [];
  switch (msg?.type) {
    case 'system':
      if (msg.subtype === 'init' && msg.session_id) events.push({ kind: 'init', sessionId: msg.session_id, model: msg.model });
      break;
    case 'assistant':
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) events.push({ kind: 'text', text: block.text });
        else if (block.type === 'tool_use') events.push({ kind: 'tool', name: block.name, summary: summarizeToolInput(block.input) });
      }
      break;
    case 'user':
      if (Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result' && block.is_error) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            events.push({ kind: 'tool-error', text: text.length > 400 ? text.slice(0, 397) + '…' : text });
          }
        }
      }
      break;
    case 'result':
      events.push({
        kind: 'result',
        ok: !msg.is_error,
        text: typeof msg.result === 'string' ? msg.result : '',
        sessionId: msg.session_id,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        denied: (msg.permission_denials ?? []).map((d: any) => ({
          tool: String(d.tool_name ?? 'tool'),
          summary: summarizeToolInput(d.tool_input),
        })),
      });
      break;
  }
  return events;
}

export function runClaude(opts: ClaudeRunOptions): Promise<void> {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', opts.permissionMode];
    if (opts.model) args.push('--model', opts.model);
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.allowedTools.length) args.push(`--allowedTools=${opts.allowedTools.join(',')}`);

    let child;
    try {
      child = spawn(opts.binary, args, { cwd: opts.cwd, env: augmentedEnv(), stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
    } catch (e) {
      opts.onEvent({ kind: 'error', message: `Could not start Claude Code: ${(e as Error).message}` });
      return resolve();
    }

    let buffered = '';
    let stderr = '';
    let sawResult = false;
    const handleLine = (line: string) => {
      for (const ev of parseStreamLine(line)) {
        if (ev.kind === 'result') sawResult = true;
        opts.onEvent(ev);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (opts.signal?.aborted) return; // reported by 'close'
      const msg =
        e.code === 'ENOENT'
          ? `Claude Code was not found at "${opts.binary}". Set claudeCpp.claudePath.`
          : `Could not start Claude Code: ${e.message}`;
      opts.onEvent({ kind: 'error', message: msg });
      sawResult = true;
      resolve();
    });
    child.on('close', (code) => {
      if (buffered.trim()) handleLine(buffered.trim());
      if (opts.signal?.aborted) opts.onEvent({ kind: 'error', message: 'Stopped.' });
      else if (!sawResult) {
        opts.onEvent({
          kind: 'error',
          message: `Claude Code exited with code ${code} before finishing.${stderr.trim() ? '\n' + stderr.trim() : ''}`,
        });
      }
      resolve();
    });

    child.stdin.on('error', () => {
      /* process died early; 'close' reports it */
    });
    child.stdin.end(opts.prompt);
  });
}
