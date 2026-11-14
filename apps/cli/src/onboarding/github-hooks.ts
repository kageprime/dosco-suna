/**
 * Repository webhooks and labels through the person's own `gh`. A secret
 * travels on stdin (`gh api --input -`), never in a command argument.
 */
import { spawnSync } from 'node:child_process';

export interface RepoHook {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  last_code: number | null;
}

function gh(args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
  if (r.error) return { ok: false, out: '', err: (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh is not installed' : r.error.message };
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/** Null when `gh` is ready; otherwise what is wrong, in one line. */
export function ghProblem(): string | null {
  const r = gh(['auth', 'status']);
  if (r.ok) return null;
  return r.err.includes('not installed') ? 'gh is not installed' : 'gh is not signed in';
}

export function listHooks(repo: string): RepoHook[] | { error: string } {
  const r = gh(['api', '--paginate', `repos/${repo}/hooks`]);
  if (!r.ok) return { error: r.err.split('\n')[0] || 'gh api failed' };
  try {
    // --paginate concatenates JSON arrays: `[...][...]`.
    const rows = JSON.parse(`[${r.out.trim().replace(/\]\s*\[/g, '],[')}]`).flat() as Array<{
      id: number; config?: { url?: string }; events?: string[]; active?: boolean; last_response?: { code?: number | null };
    }>;
    return rows.map((row) => ({ id: row.id, url: row.config?.url ?? '', events: row.events ?? [], active: row.active !== false, last_code: row.last_response?.code ?? null }));
  } catch {
    return { error: 'gh returned unreadable hooks' };
  }
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The hook that calls this trigger: the same URL path on any host. The path
 * holds the workspace id, so a tunnel that moved still matches and a hook of
 * another workspace never does.
 */
export function findHook(hooks: RepoHook[], webhookUrl: string | null, _slug?: string): RepoHook | null {
  const path = webhookUrl ? pathOf(webhookUrl) : null;
  if (!path) return null;
  return hooks.find((h) => h.url === webhookUrl) ?? hooks.find((h) => pathOf(h.url) === path) ?? null;
}

/** Active hooks that send the same trigger slug to ANOTHER Kortix workspace. */
export function foreignHooks(hooks: RepoHook[], webhookUrl: string | null, slug: string): Array<RepoHook & { workspace: string }> {
  const own = webhookUrl ? pathOf(webhookUrl) : null;
  return hooks.flatMap((h) => {
    const match = h.active ? pathOf(h.url)?.match(/\/v1\/webhooks\/workspaces\/([^/]+)\/([^/]+)$/) : null;
    return match && match[2] === slug && pathOf(h.url) !== own ? [{ ...h, workspace: match[1]! }] : [];
  });
}

function hookBody(url: string, events: string[], secret: string): string {
  return JSON.stringify({ name: 'web', active: true, events, config: { url, content_type: 'json', insecure_ssl: '0', secret } });
}

export function createHook(repo: string, url: string, events: string[], secret: string): { ok: boolean; error?: string } {
  const r = gh(['api', `repos/${repo}/hooks`, '--method', 'POST', '--input', '-'], hookBody(url, events, secret));
  return r.ok ? { ok: true } : { ok: false, error: r.err.split('\n')[0] };
}

export function updateHook(repo: string, id: number, url: string, events: string[], secret: string): { ok: boolean; error?: string } {
  const r = gh(['api', `repos/${repo}/hooks/${id}`, '--method', 'PATCH', '--input', '-'], hookBody(url, events, secret));
  return r.ok ? { ok: true } : { ok: false, error: r.err.split('\n')[0] };
}

/** `created`, `exists`, or an error line. */
export function ensureLabel(repo: string, name: string): 'created' | 'exists' | { error: string } {
  if (gh(['api', `repos/${repo}/labels/${encodeURIComponent(name)}`]).ok) return 'exists';
  const r = gh(['api', `repos/${repo}/labels`, '--method', 'POST', '-f', `name=${name}`, '-f', 'color=5319e7', '-f', 'description=Kortix agents pick this up']);
  return r.ok ? 'created' : { error: r.err.split('\n')[0] || 'gh label create failed' };
}

export function labelExists(repo: string, name: string): boolean {
  return gh(['api', `repos/${repo}/labels/${encodeURIComponent(name)}`]).ok;
}
