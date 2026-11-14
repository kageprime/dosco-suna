/**
 * A task id: where a task lives and the commit it was read at, signed for one
 * project. The API mints it from a source it trusts (a suite of kortix.yaml, a
 * built-in dataset, the Harbor registry), so a reader cannot make the API fetch
 * a repository nothing names: an id whose signature does not verify is no task.
 *
 * Shape: `<base64url JSON>~<HMAC-SHA-256, 16 bytes, base64url>`. `~` is URL-safe
 * and never in base64url; a `.` would make a web route read the last path
 * segment as a static file. The key is derived from `API_KEY_SECRET`, and the
 * MAC covers the project id.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import type { EvalTaskRef } from './task-source';

// replica-local: the derived key per secret value, computed once.
const keys = new Map<string, Buffer>();

function signingKey(): Buffer | null {
  const secret = config.API_KEY_SECRET;
  if (!secret) return null;
  const cached = keys.get(secret);
  if (cached) return cached;
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('kortix-eval-task-id-v1', 'utf8'), 32));
  keys.set(secret, key);
  return key;
}

const SEPARATOR = '~';

const mac = (key: Buffer, projectId: string, body: string): Buffer => createHmac('sha256', key).update(`${projectId}.${body}`).digest().subarray(0, 16);

const SHA = /^[0-9a-f]{40}$/i;
const safePath = (path: unknown): path is string => typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..');

/** The id of a task at `commit` (the project commit for a repository task; a git task carries its own). */
export function encodeTaskId(projectId: string, ref: EvalTaskRef, projectCommit: string): string {
  const key = signingKey();
  if (!key) throw new Error('API_KEY_SECRET must be configured to mint eval task ids');
  const fields = ref.kind === 'repo' ? { k: 'repo', p: ref.path, c: projectCommit } : { k: 'git', p: ref.path, c: ref.commit, u: ref.git_url };
  const body = Buffer.from(JSON.stringify(fields)).toString('base64url');
  return `${body}${SEPARATOR}${mac(key, projectId, body).toString('base64url')}`;
}

/** The task an id names, or null when it is not an id this API minted for this project. */
export function decodeTaskId(projectId: string, taskId: string): { ref: EvalTaskRef; commit: string } | null {
  const key = signingKey();
  const [body, signature, extra] = taskId.split(SEPARATOR);
  if (!key || !body || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, projectId, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const fields = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { k?: unknown; p?: unknown; c?: unknown; u?: unknown };
    if (!safePath(fields.p) || typeof fields.c !== 'string' || !SHA.test(fields.c)) return null;
    if (fields.k === 'repo') return { ref: { kind: 'repo', path: fields.p }, commit: fields.c };
    if (fields.k === 'git' && typeof fields.u === 'string') return { ref: { kind: 'git', git_url: fields.u, commit: fields.c, path: fields.p }, commit: fields.c };
    return null;
  } catch {
    return null;
  }
}
