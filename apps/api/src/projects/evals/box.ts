/**
 * What the eval runner does inside a trial's sandbox, through the PROVIDER's
 * exec channel (not the in-box daemon): it works the same while no turn runs,
 * and the agent under test cannot intercept it.
 *
 * A verifier or a solution can run for minutes and one exec call cannot, so a
 * long command runs detached: `launch` starts it, `poll` reads its exit code.
 * Its state is in /var/tmp (Platinum's /tmp is tmpfs in RAM).
 *
 * Every command runs as root, which is Harbor's default user for the verifier.
 */
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { getProvider, isProviderName } from '../../platform/providers';
import { db } from '../../shared/db';
import { EvalTrialError } from './scoring';
import type { TaskFile } from './task-source';

export interface Box {
  provider: string;
  externalId: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The sandbox operations the runner needs. Swapped for a recorder in tests. */
export interface BoxOps {
  exec(box: Box, script: string, timeoutMs?: number): Promise<ExecResult>;
}

const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Run as root whatever user the provider's exec channel uses. The script is in
 * the command once: Linux caps one argument at 128 KiB (MAX_ARG_STRLEN), and a
 * copy per branch doubled an upload chunk past it.
 */
const asRoot = (script: string): string => `S=${q(script)}; if [ "$(id -u)" = 0 ]; then bash -c "$S"; else sudo -n bash -c "$S"; fi`;

const liveOps: BoxOps = {
  async exec(box, script, timeoutMs = 30_000) {
    if (!isProviderName(box.provider)) throw new EvalTrialError('RuntimeRequestError', `Sandbox provider ${box.provider} is not supported.`);
    const provider = getProvider(box.provider);
    if (!provider.exec) throw new EvalTrialError('RuntimeRequestError', `Sandbox provider ${box.provider} cannot run commands.`);
    // A rate limit of the provider (Platinum answers `429 rate_limited` above 20 writes a second per org, and a job starts
    // many trials at once) is not a trial failure: wait its `retry-after`, a few times, before the trial errors.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await provider.exec(box.externalId, ['bash', '-c', asRoot(script)], { timeoutMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const wait = rateLimitWaitMs(message);
        if (wait !== null && attempt < EXEC_RATE_LIMIT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        throw new EvalTrialError('RuntimeRequestError', `The sandbox did not run the command: ${message.slice(0, 300)}`);
      }
    }
  },
};

const EXEC_RATE_LIMIT_ATTEMPTS = 5;

/** The wait a provider's rate-limit error asks for (`429` … `retry-after=2`), with jitter; null for any other error. */
export function rateLimitWaitMs(message: string): number | null {
  if (!/\b429\b|rate_limited|too many/i.test(message)) return null;
  const seconds = Number(/retry-after=(\d+(?:\.\d+)?)/i.exec(message)?.[1] ?? 1);
  return Math.min(10_000, Math.max(250, seconds * 1000)) + Math.floor(Math.random() * 500);
}

export const boxOps = (): BoxOps => liveOps;

/** The trial session's sandbox once the provider has created it, and whether it runs. */
export async function sessionBox(sessionId: string): Promise<{ box: Box | null; status: string } | null> {
  const [row] = await db
    .select({ provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId, status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!row) return null;
  return { box: row.externalId ? { provider: row.provider, externalId: row.externalId } : null, status: row.status };
}

/** True once the sandbox answers a command. */
export async function boxReady(box: Box): Promise<boolean> {
  try {
    return (await boxOps().exec(box, 'true', 10_000)).exitCode === 0;
  } catch {
    return false;
  }
}

/** Bytes per exec call: 64 KiB as base64, half the 128 KiB a single Linux argument may hold. */
const UPLOAD_CHUNK_BYTES = 48 * 1024;

async function run(box: Box, script: string): Promise<void> {
  const result = await boxOps().exec(box, script, 60_000);
  if (result.exitCode !== 0) throw new Error(result.stderr.slice(0, 300) || `exit ${result.exitCode}`);
}

/**
 * Write one file, creating its folder. An existing file or symlink at the path
 * is replaced, never followed. `mode` sets its permissions (octal).
 */
export async function writeBoxFile(box: Box, target: string, bytes: Uint8Array, mode?: number): Promise<void> {
  await run(box, `mkdir -p -- "$(dirname -- ${q(target)})" && rm -f -- ${q(target)} && : > ${q(target)}`);
  for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = Buffer.from(bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES)).toString('base64');
    await run(box, `printf %s ${q(chunk)} | base64 -d >> ${q(target)}`);
  }
  if (mode !== undefined) await run(box, `chmod ${(mode & 0o777).toString(8)} -- ${q(target)}`);
}

/** Make `path` a symlink to `target`, replacing what is there. */
export async function writeBoxSymlink(box: Box, path: string, target: string): Promise<void> {
  await run(box, `mkdir -p -- "$(dirname -- ${q(path)})" && rm -rf -- ${q(path)} && ln -s -- ${q(target)} ${q(path)}`);
}

export async function makeBoxDir(box: Box, path: string): Promise<void> {
  await run(box, `mkdir -p -- ${q(path)}`);
}

/** Replace `dir` in the sandbox with these files. Scripts get the execute bit. */
export async function uploadDir(box: Box, dir: string, files: readonly TaskFile[]): Promise<void> {
  await run(box, `rm -rf -- ${q(dir)} && mkdir -p -- ${q(dir)}`);
  for (const file of files) await writeBoxFile(box, `${dir}/${file.path}`, file.bytes);
  await run(box, `find ${q(dir)} -type f \\( -name '*.sh' -o -name '*.py' \\) -exec chmod +x {} + ; true`);
}

/** Bytes per read: 768 KiB, about 1 MiB of base64 on stdout. */
const READ_CHUNK_BYTES = 768 * 1024;

/** A whole file, read in chunks; null when it is not a regular file. */
export async function readBoxFile(box: Box, path: string, size: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size || offset === 0; offset += READ_CHUNK_BYTES) {
    const result = await boxOps().exec(box, `[ -f ${q(path)} ] && [ ! -L ${q(path)} ] || exit 44; tail -c +${offset + 1} -- ${q(path)} | head -c ${READ_CHUNK_BYTES} | base64 -w0`, 60_000);
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw new EvalTrialError('DownloadVerifierDirError', `Could not read ${path}: ${result.stderr.slice(0, 200)}`);
    const chunk = Buffer.from(result.stdout.trim(), 'base64');
    // The file changed size under the read: keep what was there when it was listed.
    out.set(chunk.subarray(0, Math.max(0, size - offset)), offset);
    if (size === 0) break;
  }
  return out;
}

/** What is at a sandbox path, without following a symlink. */
export type BoxNode =
  | { kind: 'missing' }
  | { kind: 'other' }
  | { kind: 'symlink'; target: string }
  | { kind: 'file'; mode: number; size: number }
  | { kind: 'dir'; entries: BoxTreeEntry[]; truncated: boolean };

/** One entry below a directory: `find -printf %y` type, octal mode, size, path relative to the directory, link target. */
export interface BoxTreeEntry {
  type: string;
  mode: number;
  size: number;
  path: string;
  target: string;
}

/** Describe `path`; for a directory, list up to `limit` entries below it (any depth, symlinks not followed). */
export async function statBoxTree(box: Box, path: string, limit: number): Promise<BoxNode> {
  const script = [
    `S=${q(path)}`,
    'if [ -L "$S" ]; then printf "L\\0%s" "$(readlink -- "$S")"; exit 0; fi',
    'if [ -f "$S" ]; then printf "F\\0%s\\0%s" "$(stat -c %a -- "$S")" "$(stat -c %s -- "$S")"; exit 0; fi',
    `if [ -d "$S" ]; then printf "D\\0"; cd -- "$S" && find . -mindepth 1 -printf '%y\\t%m\\t%s\\t%P\\t%l\\0' 2>/dev/null | head -z -n ${Math.floor(limit) + 1}; exit 0; fi`,
    'if [ -e "$S" ]; then printf "O"; else printf "M"; fi',
  ].join('\n');
  const result = await boxOps().exec(box, script, 60_000);
  if (result.exitCode !== 0) throw new EvalTrialError('DownloadVerifierDirError', `Could not list ${path}: ${result.stderr.slice(0, 200)}`);
  const [head, ...rest] = result.stdout.split('\0');
  if (head === 'M') return { kind: 'missing' };
  if (head === 'L') return { kind: 'symlink', target: rest[0] ?? '' };
  if (head === 'F') return { kind: 'file', mode: parseInt(rest[0] ?? '644', 8), size: Number(rest[1]) || 0 };
  if (head !== 'D') return { kind: 'other' };
  const entries = rest
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 5 && parts[3])
    .map(([type, mode, size, entryPath, ...target]) => ({ type: type!, mode: parseInt(mode!, 8), size: Number(size) || 0, path: entryPath!, target: target.join('\t') }));
  return { kind: 'dir', entries: entries.slice(0, limit), truncated: entries.length > limit };
}

const runDir = (id: string): string => `/var/tmp/kortix-eval/${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

/**
 * Start `command` detached, in `cwd`, with `env`, its output in `outputPath`.
 * It is killed after `timeoutSec` (exit code 124). Starting the same id twice
 * starts it once.
 */
export async function launch(
  box: Box,
  id: string,
  input: {
    command: string;
    cwd: string | null;
    env: Record<string, string>;
    timeoutSec: number;
    outputPath: string;
    /** Run as this user when the image has it (Harbor's `[agent] user`), else as root. */
    user?: string | null;
  },
): Promise<void> {
  const dir = runDir(id);
  const exports = Object.entries(input.env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${q(value)}`)
    .join('\n');
  const body = [
    '#!/bin/bash',
    // The task's working directory when the image has it, else the sandbox's own.
    input.cwd ? `cd ${q(input.cwd)} 2>/dev/null || true` : '',
    exports,
    input.command,
  ].filter(Boolean).join('\n');
  const seconds = Math.max(1, Math.ceil(input.timeoutSec));
  // The wrapper records its own pid and the exit code. It is a file, not a nested `bash -c`, so no quoting
  // layer can break it. `(setsid … &)` makes it its own session, re-parented to init.
  const wrapper = [
    '#!/bin/bash',
    `D=${q(dir)}`,
    'echo $$ > "$D/pid"',
    `U=${q(input.user ?? '')}`,
    'if [ -n "$U" ] && id -u "$U" >/dev/null 2>&1; then RUN="runuser -u $U -- bash"; else RUN=bash; fi',
    `timeout -k 10 ${seconds} $RUN "$D/run.sh" > ${q(input.outputPath)} 2>&1 < /dev/null`,
    'echo $? > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
  ].join('\n');
  const script = [
    `D=${q(dir)}`,
    '[ -f "$D/started" ] && exit 0',
    `mkdir -p "$D" "$(dirname -- ${q(input.outputPath)})"`,
    `printf %s ${q(Buffer.from(body).toString('base64'))} | base64 -d > "$D/run.sh"`,
    `printf %s ${q(Buffer.from(wrapper).toString('base64'))} | base64 -d > "$D/wrap.sh"`,
    // Another user runs the script: it reads it, never writes it.
    'chmod 755 "$D" && chmod 644 "$D/run.sh"',
    ': > "$D/started"',
    '(setsid bash "$D/wrap.sh" < /dev/null > /dev/null 2>&1 &)',
    // Return only once the wrapper runs in its own session: the exec ends the call's processes when it
    // returns, and a child that has not reached setsid() yet dies with them.
    'for _ in $(seq 1 100); do [ -s "$D/pid" ] && exit 0; sleep 0.05; done',
    'echo "the command did not start within 5 s" >&2; exit 1',
  ].join('\n');
  const result = await boxOps().exec(box, script, 30_000);
  if (result.exitCode !== 0) throw new EvalTrialError('RuntimeRequestError', `The command did not start: ${result.stderr.slice(0, 300) || `exit ${result.exitCode}`}`);
}

export type RunState = { state: 'running' } | { state: 'done'; exitCode: number } | { state: 'missing' };

export async function poll(box: Box, id: string): Promise<RunState> {
  const dir = runDir(id);
  const result = await boxOps().exec(box, `if [ -f ${q(`${dir}/exit`)} ]; then echo "done $(cat ${q(`${dir}/exit`)})"; elif [ -f ${q(`${dir}/started`)} ]; then echo running; else echo missing; fi`, 15_000);
  const line = result.stdout.trim();
  if (line.startsWith('done')) return { state: 'done', exitCode: Number(line.slice(4).trim()) || 0 };
  return line === 'running' ? { state: 'running' } : { state: 'missing' };
}

/** Stop a detached command: its whole session, so children die with it. */
export async function kill(box: Box, id: string): Promise<void> {
  const dir = runDir(id);
  await boxOps()
    .exec(box, `P="$(cat ${q(`${dir}/pid`)} 2>/dev/null)"; [ -n "$P" ] && { pkill -TERM -s "$P" 2>/dev/null; kill -TERM -- "-$P" 2>/dev/null; sleep 1; pkill -KILL -s "$P" 2>/dev/null; }; true`, 15_000)
    .catch(() => undefined);
}

/** The last `maxBytes` of a text file, or null when it does not exist. */
export async function readTextFile(box: Box, path: string, maxBytes: number): Promise<string | null> {
  const result = await boxOps().exec(box, `[ -f ${q(path)} ] || exit 44; tail -c ${Math.floor(maxBytes)} -- ${q(path)} | base64 -w0`, 30_000);
  if (result.exitCode === 44) return null;
  if (result.exitCode !== 0) throw new EvalTrialError('DownloadVerifierDirError', `Could not read ${path}: ${result.stderr.slice(0, 200)}`);
  return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
}

/** The regular files directly or deeply under `dir`, smallest first, at most `limit`. */
export async function listFiles(box: Box, dir: string, limit: number): Promise<Array<{ path: string; size: number }>> {
  const result = await boxOps().exec(box, `[ -d ${q(dir)} ] || exit 0; cd ${q(dir)} && find . -type f -printf '%s\\t%P\\n' 2>/dev/null | sort -n | head -n ${Math.floor(limit)}`, 30_000);
  return result.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length === 2 && parts[1])
    .map(([size, path]) => ({ path: path!, size: Number(size) || 0 }));
}
