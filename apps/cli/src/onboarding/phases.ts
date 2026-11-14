/**
 * The phases of `kortix onboard`: each makes one part of kortix.yaml real on
 * the workspace and is safe to run again (it skips what is done). `kortix
 * doctor --loops --fix` runs the same phases for its red lines.
 *
 * Secret values stay in this process: a pushed env value is read from the
 * file and posted; a generated webhook secret is kept in memory for the
 * webhook phase and reaches GitHub on `gh`'s stdin.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ApiClient } from '../api/client.ts';
import { resolveProjectContext } from '../command-helpers.ts';
import { inviteLine, joinSlackChannels } from '../commands/channels-join.ts';
import { parseDotenv } from '../commands/env.ts';
import { currentBuildIds, reconcileTemplates, waitForTemplate } from '../commands/sandboxes-build.ts';
import { runGit } from '../git-run.ts';
import { classifyEnvKey } from './repo-scan.ts';
import { createHook, ensureLabel, findHook, foreignHooks, ghProblem, listHooks, type RepoHook, updateHook } from './github-hooks.ts';
import type { ManifestNeeds } from './manifest-needs.ts';
import { runSelf } from './self-cli.ts';

export type PhaseStatus = 'done' | 'skipped' | 'failed' | 'waiting_on_person';
export type PhaseName = 'validate' | 'ship' | 'secrets' | 'sandbox' | 'webhooks' | 'slack' | 'connectors' | 'doctor';

export interface PhaseResult {
  name: PhaseName;
  status: PhaseStatus;
  duration_ms: number;
  detail: string;
}

export interface UserAction {
  kind: 'secret_request' | 'github_app_install' | 'slack_install' | 'slack_invite' | 'connector_sign_in' | 'run';
  what: string;
  url?: string;
  command?: string;
}

export interface OnboardOptions {
  envFiles: Array<{ file: string; only: string[] }>;
  allowRemote: boolean;
  channels: string[];
  /** Connector slugs to connect beyond the ones kortix.yaml declares. */
  connect: string[];
  githubToken: string | null;
  buildTimeoutSec: number;
  message: string;
  /** Display name for a workspace this run creates. */
  name?: string | null;
}

export interface OnboardState {
  root: string;
  needs: ManifestNeeds;
  /** `owner/repo` the GitHub webhooks go on. */
  repo: string | null;
  ctx: { client: ApiClient; projectId: string; apiBase: string } | null;
  /** Webhook secret values generated in this run: name → value. Never printed. */
  generated: Map<string, string>;
  actions: UserAction[];
  opts: OnboardOptions;
}

type PhaseOutcome = { status: PhaseStatus; detail: string };

export async function timed(name: PhaseName, fn: () => Promise<PhaseOutcome>): Promise<PhaseResult> {
  const started = Date.now();
  try {
    const outcome = await fn();
    return { name, ...outcome, duration_ms: Date.now() - started };
  } catch (err) {
    return { name, status: 'failed', detail: (err as Error).message.split('\n')[0]!, duration_ms: Date.now() - started };
  }
}

export async function resolveWorkspace(state: OnboardState): Promise<void> {
  const ctx = await resolveProjectContext({ quietWhenUnresolved: true } as Parameters<typeof resolveProjectContext>[0]).catch(() => null);
  state.ctx = ctx ? { client: ctx.client, projectId: ctx.projectId, apiBase: ctx.auth.api_base } : null;
}

function base(state: OnboardState): string {
  return `/workspaces/${state.ctx!.projectId}`;
}

// ── ship ─────────────────────────────────────────────────────────────────────

const KORTIX_PATH = /^(kortix\.ya?ml|\.kortix\/.*)$/;

/** Changed paths from `git status --porcelain` (renames: the new path). */
function changedPaths(root: string): string[] {
  return runGit(root, ['status', '--porcelain']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''));
}

export async function phaseShip(state: OnboardState): Promise<PhaseOutcome> {
  const changed = changedPaths(state.root);
  const foreign = changed.filter((path) => !KORTIX_PATH.test(path));
  if (foreign.length > 0) {
    return { status: 'failed', detail: `${foreign.length} changed files outside kortix.yaml and .kortix/ (first: ${foreign[0]}): commit them or move them aside, then run onboard again` };
  }
  if (changed.length === 0 && state.ctx) {
    const head = runGit(state.root, ['rev-parse', 'HEAD']).stdout.trim();
    const pushed = runGit(state.root, ['branch', '-r', '--contains', 'HEAD']).stdout.trim() !== '';
    const triggers = await state.ctx.client.get<{ triggers: Array<{ slug: string }> }>(`${base(state)}/triggers`).catch(() => null);
    const live = new Set((triggers?.triggers ?? []).map((t) => t.slug));
    if (pushed && triggers && state.needs.triggers.every((t) => live.has(t.slug))) {
      return { status: 'skipped', detail: `workspace in sync at ${head.slice(0, 7)}` };
    }
  }
  const args = ['ship', '-y', '--no-env', '--no-connect', '-m', state.opts.message];
  if (state.opts.name && !state.ctx) args.push('--name', state.opts.name);
  if (state.opts.githubToken) args.push('--github-token', '-');
  const run = await runSelf(args, state.root, state.opts.githubToken ?? undefined);
  const out = `${run.stdout}\n${run.stderr}`;
  if (run.code !== 0) {
    const install = out.match(/Kortix GitHub App not installed[\s\S]*?(https:\/\/\S+)/);
    if (install) {
      state.actions.push({ kind: 'github_app_install', what: 'Install the Kortix GitHub App on the repository (one click), then run onboard again', url: install[1]!.replace(/\u001b\[[0-9;]*m/g, '') });
      return { status: 'waiting_on_person', detail: 'the Kortix GitHub App is not installed on the repository (or pass --github-token - on stdin)' };
    }
    const last = out.split('\n').map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean).slice(-2).join(' / ');
    return { status: 'failed', detail: `kortix ship exited ${run.code}: ${last}` };
  }
  await resolveWorkspace(state);
  if (!state.ctx) return { status: 'failed', detail: 'kortix ship finished but no workspace is linked here' };
  return { status: 'done', detail: `pushed ${runGit(state.root, ['rev-parse', '--short', 'HEAD']).stdout.trim()} to workspace ${state.ctx.projectId}` };
}

// ── secrets ──────────────────────────────────────────────────────────────────

export async function phaseSecrets(state: OnboardState): Promise<PhaseOutcome> {
  if (!state.ctx) return { status: 'failed', detail: 'no workspace' };
  const { client } = state.ctx;
  const resp = await client.get<{ items?: Array<{ name: string; configured: boolean }> }>(`${base(state)}/secrets`);
  const set = new Set((resp.items ?? []).filter((r) => r.configured).map((r) => r.name));
  const notes: string[] = [];
  const errors: string[] = [];

  // 1. Approved names from local env files, values read here and posted.
  let pushed = 0;
  for (const { file, only } of state.opts.envFiles) {
    const path = resolve(state.root, file);
    const pairs = new Map(parseDotenv(readFileSync(path, 'utf8')).map((p) => [p.name, p.value]));
    for (const name of only) {
      const value = pairs.get(name);
      if (value === undefined) { errors.push(`${name} is not set in ${file}`); continue; }
      if (value.startsWith('encrypted:')) { errors.push(`${name} in ${file} is dotenvx-encrypted: push a decrypted copy`); continue; }
      const cls = classifyEnvKey(file, name, value);
      if (cls === 'prod') { errors.push(`${name} in ${file} looks like production: never pushed`); continue; }
      if (cls === 'remote' && !state.opts.allowRemote) { errors.push(`${name} in ${file} points at a remote host: pass --allow-remote to push it`); continue; }
      if (set.has(name)) continue;
      await client.post(`${base(state)}/secrets`, { name, value });
      set.add(name);
      pushed += 1;
    }
  }
  if (pushed) notes.push(`${pushed} pushed from env files`);

  // 2. Webhook secrets nobody has to bring: generate, store for the connector, keep for the webhooks.
  let generated = 0;
  for (const secret of state.needs.secrets.filter((s) => s.webhook && !set.has(s.name))) {
    const value = randomBytes(32).toString('hex');
    await client.post(`${base(state)}/secrets`, { name: secret.name, value, strategy: 'broker', consumer: 'connector' });
    state.generated.set(secret.name, value);
    set.add(secret.name);
    generated += 1;
  }
  if (generated) notes.push(`${generated} webhook secrets generated`);

  // 3. The rest is a person's value: one intake link for the required names.
  const required = state.needs.secrets.filter((s) => s.required && !set.has(s.name)).map((s) => s.name);
  const optional = state.needs.secrets.filter((s) => !s.required && !set.has(s.name)).map((s) => s.name);
  if (required.length) {
    const link = await client.post<{ url: string }>(`${base(state)}/secret-requests`, { names: required, scope: 'runtime' });
    state.actions.push({ kind: 'secret_request', what: `Paste the values of ${required.join(', ')}`, url: link.url });
    notes.push(`link for ${required.length} names a person must paste`);
  }
  if (optional.length) notes.push(`optional, not set: ${optional.join(', ')}`);

  if (errors.length) return { status: 'failed', detail: [...errors, ...notes].join('; ') };
  if (required.length) return { status: 'waiting_on_person', detail: notes.join('; ') };
  if (!pushed && !generated) return { status: 'skipped', detail: state.needs.secrets.length ? `every required secret is set${optional.length ? `; optional, not set: ${optional.join(', ')}` : ''}` : 'kortix.yaml names no secret' };
  return { status: 'done', detail: notes.join('; ') };
}

// ── sandbox ──────────────────────────────────────────────────────────────────

interface SnapshotsBody { templates?: Array<{ slug: string; ready: boolean }>; builds?: Array<{ slug?: string; template_slug?: string | null; status?: string; error?: string | null }> }

export async function phaseSandbox(state: OnboardState): Promise<PhaseOutcome> {
  const slugs = state.needs.sandbox_templates;
  if (slugs.length === 0) return { status: 'skipped', detail: 'kortix.yaml declares no sandbox template' };
  if (!state.ctx) return { status: 'failed', detail: 'no workspace' };
  const { client } = state.ctx;
  const b = base(state);
  const isReady = (body: SnapshotsBody, slug: string) =>
    body.templates?.find((t) => t.slug === slug)?.ready === true || (body.builds ?? []).find((x) => (x.template_slug ?? x.slug) === slug)?.status === 'ready';
  const before = await client.get<SnapshotsBody>(`${b}/snapshots`);
  const pending = slugs.filter((slug) => !isReady(before, slug));
  if (pending.length === 0) return { status: 'skipped', detail: `built: ${slugs.join(', ')}` };

  const known = await currentBuildIds(client, b);
  await reconcileTemplates(client, b);
  const list = await client.get<{ items: Array<{ slug: string; template_id: string | null }> }>(`${b}/sandbox-templates`);
  const after = await client.get<SnapshotsBody>(`${b}/snapshots`);
  const results: string[] = [];
  let failed = false;
  for (const slug of pending) {
    const running = (after.builds ?? []).find((x) => (x.template_slug ?? x.slug) === slug)?.status === 'building';
    if (!running && !isReady(after, slug)) {
      const id = list.items.find((t) => t.slug === slug)?.template_id;
      if (!id) { results.push(`${slug}: not on the workspace (ship first)`); failed = true; continue; }
      await client.post(`${b}/sandbox-templates/${id}/build`);
    }
    const code = await waitForTemplate(client, b, slug, { knownBuildIds: known, timeoutSec: state.opts.buildTimeoutSec, json: false, silent: true });
    if (code === 0) results.push(`${slug}: built`);
    else {
      failed = true;
      const last = (await client.get<SnapshotsBody>(`${b}/snapshots`).catch(() => ({}) as SnapshotsBody)).builds?.find((x) => (x.template_slug ?? x.slug) === slug);
      results.push(last?.status === 'failed' ? `${slug}: build failed: ${(last.error ?? '').split('\n')[0]!.slice(0, 160)}` : `${slug}: not ready after ${state.opts.buildTimeoutSec}s`);
    }
  }
  return { status: failed ? 'failed' : 'done', detail: results.join('; ') };
}

// ── GitHub webhooks + labels ─────────────────────────────────────────────────

export async function phaseWebhooks(state: OnboardState): Promise<PhaseOutcome> {
  const wanted = state.needs.github_webhooks;
  if (wanted.length === 0) return { status: 'skipped', detail: 'no webhook trigger filters on a GitHub event' };
  if (!state.ctx) return { status: 'failed', detail: 'no workspace' };
  // A trigger that filters on `body.repository.full_name` names its own repository.
  const repoOf = (want: (typeof wanted)[number]) => want.repo ?? state.repo;
  if (wanted.some((want) => !repoOf(want))) return { status: 'failed', detail: 'no GitHub repository: pass --repo <owner/repo>, or filter the trigger on body.repository.full_name' };
  const problem = ghProblem();
  if (problem) {
    state.actions.push({ kind: 'run', what: `${problem}: sign in so onboarding can create the webhooks, then run onboard again`, command: 'gh auth login' });
    return { status: 'waiting_on_person', detail: problem };
  }
  const triggers = await state.ctx.client.get<{ triggers: Array<{ slug: string; webhook_url?: string | null }> }>(`${base(state)}/triggers`);
  const urls = new Map(triggers.triggers.map((t) => [t.slug, t.webhook_url ?? null]));
  const hooksOf = new Map<string, RepoHook[]>();
  for (const repo of new Set(wanted.map((want) => repoOf(want)!))) {
    const hooks = listHooks(repo);
    if ('error' in hooks) return { status: 'failed', detail: `gh cannot read the hooks of ${repo}: ${hooks.error}` };
    hooksOf.set(repo, hooks);
  }

  const notes: string[] = [];
  const errors: string[] = [];
  // One secret signs every hook that shares it: rotating it means updating each of them.
  const groups = new Map<string, typeof wanted>();
  for (const want of wanted) {
    const key = want.secret ?? `(none):${want.slug}`;
    groups.set(key, [...(groups.get(key) ?? []), want]);
  }
  for (const [key, members] of groups) {
    const secretName = key.startsWith('(none):') ? null : key;
    const rows = members.map((want) => {
      const repo = repoOf(want)!;
      const url = urls.get(want.slug) ?? null;
      const hook = findHook(hooksOf.get(repo)!, url);
      const current = !!hook && !!url && hook.url === url && want.events.every((e) => hook.events.includes(e) || hook.events.includes('*'));
      return { want, repo, url, hook, current };
    });
    const absent = rows.filter((r) => !r.url).map((r) => r.want.slug);
    if (absent.length) { errors.push(`no webhook URL for ${absent.join(', ')} (ship first)`); continue; }
    if (rows.every((r) => r.current)) { notes.push(`${members.map((m) => m.slug).join(', ')}: in place`); continue; }
    let value = secretName ? state.generated.get(secretName) : '';
    if (secretName && value === undefined) {
      // The stored value cannot be read back: rotate it, then point every hook of the group at it.
      value = randomBytes(32).toString('hex');
      await state.ctx.client.post(`${base(state)}/secrets`, { name: secretName, value, strategy: 'broker', consumer: 'connector' });
      state.generated.set(secretName, value);
      notes.push(`${secretName} rotated`);
    }
    for (const row of rows) {
      const result = row.hook ? updateHook(row.repo, row.hook.id, row.url!, row.want.events, value ?? '') : createHook(row.repo, row.url!, row.want.events, value ?? '');
      if (result.ok) notes.push(`${row.want.slug}: ${row.hook ? 'updated' : 'created'}`);
      else errors.push(`${row.want.slug}: ${result.error}`);
    }
  }
  // A hook that sends the same trigger to another workspace is never repointed: it is that workspace's.
  const warnings: string[] = [];
  for (const want of wanted) {
    for (const other of foreignHooks(hooksOf.get(repoOf(want)!)!, urls.get(want.slug) ?? null, want.slug)) {
      warnings.push(`${want.slug}: workspace ${other.workspace.slice(0, 8)} receives the same events (hook ${other.id}, left in place)`);
    }
  }
  const labels = new Map<string, string>();
  for (const want of wanted) if (want.label) labels.set(`${repoOf(want)} ${want.label}`, want.label);
  for (const [key, label] of labels) {
    const result = ensureLabel(key.split(' ')[0]!, label);
    if (typeof result === 'object') errors.push(`label ${label}: ${result.error}`);
    else if (result === 'created') notes.push(`label ${label} created`);
  }
  if (errors.length) return { status: 'failed', detail: [...errors, ...notes, ...warnings].join('; ') };
  const changed = notes.some((n) => !n.endsWith('in place'));
  return { status: changed ? 'done' : 'skipped', detail: [...notes, ...warnings].join('; ') };
}

// ── Slack ────────────────────────────────────────────────────────────────────

/** False when the Slack app of this host sends the person back to another deployment: the install can never finish here. */
export function slackReturnsHere(installUrl: string, apiBase: string | null): boolean {
  try {
    const back = new URL(installUrl).searchParams.get('redirect_uri');
    return !back || !apiBase || new URL(back).host === new URL(apiBase).host;
  } catch {
    return true;
  }
}

export async function phaseSlack(state: OnboardState): Promise<PhaseOutcome> {
  if (state.opts.channels.length === 0 && !state.needs.uses_slack) return { status: 'skipped', detail: 'no --channels and kortix.yaml does not use Slack' };
  if (!state.ctx) return { status: 'failed', detail: 'no workspace' };
  const { client } = state.ctx;
  const install = await client.get<{ workspaceName?: string | null } | null>(`${base(state)}/channels/slack/installation`).catch(() => null);
  if (!install) {
    const mode = await client.get<{ oauth_available: boolean; install_url: string | null }>(`${base(state)}/channels/slack/mode`).catch(() => null);
    if (mode?.oauth_available && mode.install_url && slackReturnsHere(mode.install_url, state.ctx.apiBase)) state.actions.push({ kind: 'slack_install', what: 'Add Kortix to Slack: pick the Slack workspace, click Allow, then run onboard again', url: mode.install_url });
    else state.actions.push({ kind: 'slack_install', what: 'Connect Slack with a bot token (this host has no one-click Slack app), then run onboard again', command: 'kortix channels connect --manual' });
    return { status: 'waiting_on_person', detail: 'Slack is not connected' };
  }
  if (state.opts.channels.length === 0) return { status: 'skipped', detail: `connected${install.workspaceName ? ` to ${install.workspaceName}` : ''}; no --channels to join` };
  const joined = await joinSlackChannels(client, state.ctx.projectId, state.opts.channels);
  if (!joined) return { status: 'failed', detail: 'this Kortix host has no channel join route' };
  const notes: string[] = [];
  let invites = 0;
  let errors = 0;
  for (const r of joined.results) {
    if (r.status === 'joined' || r.status === 'already_member') notes.push(`#${r.channel} ${r.status === 'joined' ? 'joined' : 'already joined'}`);
    else if (r.status === 'error') { errors += 1; notes.push(`#${r.channel}: ${r.error ?? 'error'}`); }
    else { invites += 1; notes.push(`#${r.channel} needs /invite`); state.actions.push({ kind: 'slack_invite', what: inviteLine(r) }); }
  }
  const allDone = joined.results.every((r) => r.status === 'already_member');
  return { status: errors ? 'failed' : invites ? 'waiting_on_person' : allDone ? 'skipped' : 'done', detail: notes.join('; ') };
}

// ── connectors ───────────────────────────────────────────────────────────────

interface ConnectorRow { slug: string; state?: string; status?: string; authSecret?: string | null; secretSet?: boolean }

export async function phaseConnectors(state: OnboardState): Promise<PhaseOutcome> {
  const slugs = [...new Set([...state.needs.connectors.map((c) => c.slug), ...state.opts.connect])];
  if (slugs.length === 0) return { status: 'skipped', detail: 'kortix.yaml declares no connector' };
  if (!state.ctx) return { status: 'failed', detail: 'no workspace' };
  const ex = `/connectors/workspaces/${state.ctx.projectId}`;
  const { connectors } = await state.ctx.client.get<{ connectors: ConnectorRow[] }>(`${ex}/connectors?include_schemas=false`);
  const notes: string[] = [];
  let waiting = 0;
  let failed = 0;
  for (const slug of slugs) {
    const row = connectors.find((c) => c.slug === slug);
    const current = row?.state ?? row?.status;
    if (current === 'connected' || current === 'active') { notes.push(`${slug} connected`); continue; }
    if (!row) { failed += 1; notes.push(`${slug} is not on the workspace (ship first, or check the slug)`); continue; }
    if (row.authSecret && !row.secretSet) {
      const link = await state.ctx.client.post<{ url: string }>(`/workspaces/${state.ctx.projectId}/secret-requests`, { names: [row.authSecret], scope: 'connector' });
      state.actions.push({ kind: 'secret_request', what: `Paste the credential of connector ${slug} (${row.authSecret})`, url: link.url });
    } else {
      const connect = await state.ctx.client.post<{ connectUrl?: string | null; connected?: boolean; isNoAuth?: boolean }>(`${ex}/connectors/${encodeURIComponent(slug)}/connect`, { owner: 'project' });
      if (connect.connected || connect.isNoAuth) { notes.push(`${slug} connected`); continue; }
      if (!connect.connectUrl) { failed += 1; notes.push(`${slug}: no sign-in link returned`); continue; }
      state.actions.push({ kind: 'connector_sign_in', what: `Sign in to ${slug} for the workspace`, url: connect.connectUrl });
    }
    waiting += 1;
    notes.push(`${slug} needs a person`);
  }
  return { status: failed ? 'failed' : waiting ? 'waiting_on_person' : 'skipped', detail: notes.join('; ') };
}
