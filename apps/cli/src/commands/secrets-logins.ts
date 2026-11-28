/**
 * Website logins (`kortix secrets request NAME --login --site <host>`).
 *
 *   kortix secrets logins          the logins this session can use: names, sites
 *   kortix secrets browser-plugin  an agent-browser credential plugin (hidden)
 *
 * The plugin is how a login reaches a page without passing through the agent:
 * `agent-browser auth login <profile> --credential-provider kortix --item NAME
 * --url <sign-in URL>` starts it, it asks the API for that one login for that
 * one URL with the session's own token, and agent-browser types the answer
 * into the form. It speaks `agent-browser.plugin.v1` on stdio and prints
 * nothing else to stdout. agent-browser hides a plugin's error text, so the
 * last refusal is kept in a file that `kortix secrets logins` shows.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configFilePath } from '../api/config.ts';
import { ApiError } from '../api/client.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  type CtxOpts,
} from '../command-helpers.ts';
import { C, status } from '../style.ts';

const PROTOCOL = 'agent-browser.plugin.v1';
/** A refusal older than this is not shown: it is about another attempt. */
const LAST_ERROR_FRESH_MS = 15 * 60_000;

interface LoginListing {
  name: string;
  sites: string[];
  available: boolean;
  fix?: string;
}

interface LastLoginError {
  name: string | null;
  url: string | null;
  code: string | null;
  error: string;
  at: string;
}

function lastErrorPath(): string {
  return join(dirname(configFilePath()), 'browser-login-last-error.json');
}

/** Record why the plugin refused, for `kortix secrets logins`. No values. */
function recordLastError(entry: Omit<LastLoginError, 'at'>): void {
  try {
    const path = lastErrorPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ ...entry, at: new Date().toISOString() }), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Diagnostics only: a read-only home must not change the plugin's answer.
  }
}

function readLastError(now: number): LastLoginError | null {
  try {
    const entry = JSON.parse(readFileSync(lastErrorPath(), 'utf8')) as LastLoginError;
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && now - at < LAST_ERROR_FRESH_MS ? entry : null;
  } catch {
    return null;
  }
}

export async function secretsLogins(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let items: LoginListing[];
  try {
    ({ items } = await ctx.client.get<{ items: LoginListing[] }>(`/workspaces/${ctx.projectId}/browser-logins`));
  } catch (err) {
    return surfaceApiError(err);
  }
  const lastError = readLastError(Date.now());
  if (json) {
    emitJson({ items, ...(lastError ? { last_error: lastError } : {}) });
    return 0;
  }
  if (items.length === 0) {
    process.stdout.write(
      `No website logins yet. Ask the person for one: ${C.cyan}kortix secrets request NAME --login --site <host>${C.reset}\n`,
    );
  } else {
    const width = Math.max(...items.map((item) => item.name.length));
    for (const item of items) {
      const state = item.available ? `${C.green}ready${C.reset}` : `${C.yellow}not granted${C.reset}`;
      process.stdout.write(`  ${item.name.padEnd(width)}  ${item.sites.join(', ')}  ${state}\n`);
      if (item.fix) process.stdout.write(`  ${C.dim}${item.fix}${C.reset}\n`);
    }
    process.stdout.write(
      `\n  ${C.dim}Sign in: agent-browser auth login <profile> --credential-provider kortix --item <NAME> --url <sign-in page URL>${C.reset}\n`,
    );
  }
  if (lastError) {
    process.stdout.write(
      `\n${status.warn(`Last refused sign-in (${lastError.at}): ${lastError.name ?? '?'} on ${lastError.url ?? 'no URL'}`)}\n` +
        `  ${C.dim}${lastError.error}${C.reset}\n`,
    );
  }
  return 0;
}

function reply(body: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, ...body }));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One `agent-browser.plugin.v1` exchange: `plugin.manifest` or
 * `credential.resolve`. Always exits 0 with exactly one JSON object on stdout;
 * a refusal is `success: false` and its reason goes to stderr and the
 * last-error file, never the password.
 */
export async function secretsBrowserPlugin(opts: CtxOpts): Promise<number> {
  let envelope: { protocol?: unknown; type?: unknown; request?: Record<string, unknown> };
  try {
    envelope = JSON.parse(await readStdin());
  } catch {
    reply({ success: false, error: 'invalid plugin request' });
    return 0;
  }
  if (envelope.protocol !== PROTOCOL) {
    reply({ success: false, error: 'unsupported protocol' });
    return 0;
  }
  if (envelope.type === 'plugin.manifest') {
    reply({
      success: true,
      manifest: {
        name: 'kortix',
        capabilities: ['credential.read'],
        description: 'Kortix website logins: types a saved login without showing it to the agent',
      },
    });
    return 0;
  }
  if (envelope.type !== 'credential.resolve') {
    reply({ success: false, error: `unsupported request type: ${String(envelope.type)}` });
    return 0;
  }

  const request = envelope.request ?? {};
  const name =
    (typeof request.itemRef === 'string' && request.itemRef.trim()) ||
    (typeof request.profileName === 'string' && request.profileName.trim()) ||
    null;
  const url = typeof request.url === 'string' && request.url.trim() ? request.url.trim() : null;
  const refuse = (code: string | null, error: string): number => {
    recordLastError({ name, url, code, error });
    process.stderr.write(`kortix: ${error}\n`);
    reply({ success: false, error });
    return 0;
  };
  if (!name) return refuse('login_name_invalid', 'Pass the login name: --item NAME.');

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return refuse('not_logged_in', 'The kortix CLI has no session credential in this sandbox.');
  try {
    const login = await ctx.client.post<{ username: string; password: string; url: string }>(
      `/workspaces/${ctx.projectId}/browser-logins/resolve`,
      { name, ...(url ? { url } : {}) },
    );
    reply({ success: true, credential: { username: login.username, password: login.password, url: login.url } });
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      const body = (err.body ?? {}) as { code?: unknown; error?: unknown };
      return refuse(
        typeof body.code === 'string' ? body.code : `http_${err.status}`,
        typeof body.error === 'string' ? body.error : err.message,
      );
    }
    return refuse(null, err instanceof Error ? err.message : 'The login could not be resolved.');
  }
}
