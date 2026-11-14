/**
 * `kortix doctor --loops` — one green/red list for whatever this repository's
 * kortix.yaml (with its imports) declares: manifest valid, workspace linked,
 * every referenced secret set, triggers live, sandbox templates built, GitHub
 * webhooks in place, connectors and Slack connected, a model that answers,
 * and the public URL when the API runs behind a quick tunnel. Each red line
 * names its fix; `--fix` runs the onboarding phase that repairs it.
 */
import { sdkBackendUrl } from '../api/sdk.ts';
import type { ApiClient } from '../api/client.ts';
import { formatIssueLine, validateManifestFile } from '../manifest.ts';
import { findHook, foreignHooks, ghProblem, labelExists, listHooks, type RepoHook } from './github-hooks.ts';
import type { ManifestNeeds } from './manifest-needs.ts';

export type CheckState = 'ok' | 'fail' | 'warn';

/** The onboarding phase that turns a red line green. */
export type FixPhase = 'ship' | 'secrets' | 'sandbox' | 'webhooks' | 'slack' | 'connectors';

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** The command or action that turns it green. */
  fix?: string;
  /** `--fix` runs this phase for the line. */
  phase?: FixPhase;
}

export interface DoctorContext {
  root: string;
  manifestFile: string | null;
  needs: ManifestNeeds | null;
  client: ApiClient | null;
  projectId: string | null;
  apiBase: string | null;
  /** `owner/repo` for the GitHub webhooks. */
  repo: string | null;
  /** Probe for the tunnel check; tests replace it. */
  fetchHealth?: (url: string) => Promise<number>;
}

interface SecretRow { name: string; configured: boolean }
interface TriggerRow { slug: string; enabled: boolean; type?: string; webhook_url?: string | null }
interface SnapshotsBody { templates?: Array<{ slug: string; ready: boolean }>; builds?: Array<{ slug?: string; template_slug?: string | null; status?: string; error?: string | null }> }
interface ConnectorRow { slug: string; state?: string; status?: string }

/** The pure verdict for one check list: exit 1 when any line is red. */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((check) => check.state === 'fail') ? 1 : 0;
}

/** The API answers through a Cloudflare quick tunnel, which changes on every restart. */
export function isQuickTunnel(apiBase: string | null): boolean {
  if (!apiBase) return false;
  try {
    return new URL(apiBase).hostname.endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}

async function get<T>(client: ApiClient, path: string): Promise<T | null> {
  return client.get<T>(path).catch(() => null);
}

/**
 * The tunnel probe goes through the CLI's own client: the check runs only when
 * that client's base IS the tunnel, so a health call is the same request.
 */
function clientHealth(client: ApiClient | null): (url: string) => Promise<number> {
  return async () => {
    if (!client) return 0;
    return client.get('/health').then(() => 200, () => 0);
  };
}

export async function collectLoopChecks(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  if (!ctx.manifestFile) {
    checks.push({ name: 'manifest', state: 'fail', detail: 'no kortix.yaml in this repository', fix: 'write kortix.yaml (kortix init, or adapt a reference repository from kortix plan)' });
    return checks;
  }
  const { issues } = validateManifestFile(ctx.manifestFile);
  const errors = issues.filter((issue) => issue.severity === 'error');
  checks.push(
    errors.length === 0
      ? { name: 'manifest', state: issues.length ? 'warn' : 'ok', detail: issues.length ? `${issues.length} warnings (kortix validate)` : 'valid' }
      : { name: 'manifest', state: 'fail', detail: `${errors.length} errors: ${formatIssueLine(errors[0]!, ctx.root).trim()}`, fix: 'kortix validate' },
  );
  const needs = ctx.needs;

  if (isQuickTunnel(ctx.apiBase)) {
    const url = `${sdkBackendUrl(ctx.apiBase!)}/health`;
    const code = await (ctx.fetchHealth ?? clientHealth(ctx.client))(url).catch(() => 0);
    checks.push(
      code >= 200 && code < 300
        ? { name: 'public URL', state: 'ok', detail: `${new URL(url).host} answers /v1/health` }
        : { name: 'public URL', state: 'fail', detail: `${new URL(url).host} does not answer /v1/health (${code || 'no answer'}): webhooks and sandboxes cannot reach the API`, fix: 'restart the tunnel (pnpm dev), then kortix doctor --loops --fix to point the webhooks at the new URL' },
      );
  }

  if (!ctx.client || !ctx.projectId) {
    checks.push({ name: 'workspace', state: 'fail', detail: 'this folder is not linked to a Kortix workspace', fix: 'kortix ship', phase: 'ship' });
    return checks;
  }
  checks.push({ name: 'workspace', state: 'ok', detail: ctx.projectId });
  if (!needs) return checks;
  const base = `/workspaces/${ctx.projectId}`;
  const client = ctx.client;

  const [secretsResp, triggersResp, snapshots, connectorsResp, slack, picker] = await Promise.all([
    get<{ items?: SecretRow[] }>(client, `${base}/secrets`),
    get<{ triggers: TriggerRow[]; triggers_paused?: boolean }>(client, `${base}/triggers`),
    needs.sandbox_templates.length ? get<SnapshotsBody>(client, `${base}/snapshots`) : Promise.resolve(null),
    needs.connectors.length ? get<{ connectors: ConnectorRow[] }>(client, `/connectors${base}/connectors?include_schemas=false`) : Promise.resolve(null),
    needs.uses_slack ? get<{ workspaceName?: string | null } | null>(client, `${base}/channels/slack/installation`) : Promise.resolve(null),
    get<{ models?: Record<string, { available?: boolean }>; defaultModel?: string }>(client, `${base}/model-picker`),
  ]);

  // Secrets: a webhook secret is generated by onboarding; any other is a person's value.
  const set = new Set((secretsResp?.items ?? []).filter((row) => row.configured).map((row) => row.name));
  const unset = needs.secrets.filter((s) => !set.has(s.name));
  const webhookMissing = unset.filter((s) => s.webhook && s.required).map((s) => s.name);
  const personMissing = unset.filter((s) => !s.webhook && s.required).map((s) => s.name);
  const optionalMissing = unset.filter((s) => !s.required).map((s) => s.name);
  if (needs.secrets.length === 0) checks.push({ name: 'secrets', state: 'ok', detail: 'kortix.yaml names no secret' });
  else if (!secretsResp) checks.push({ name: 'secrets', state: 'fail', detail: 'cannot read the workspace secrets' });
  else {
    if (webhookMissing.length) checks.push({ name: 'webhook secrets', state: 'fail', detail: `not set: ${webhookMissing.join(', ')}`, fix: 'kortix doctor --loops --fix (generates them)', phase: 'secrets' });
    checks.push(
      personMissing.length
        ? { name: 'secrets', state: 'fail', detail: `not set: ${personMissing.join(', ')}`, fix: `kortix secrets request ${personMissing.join(' ')} --scope runtime`, phase: 'secrets' }
        : { name: 'secrets', state: optionalMissing.length ? 'warn' : 'ok', detail: optionalMissing.length ? `optional not set: ${optionalMissing.join(', ')}` : `${needs.secrets.length - optionalMissing.length} set` },
    );
  }

  // Triggers: every declared slug exists on the workspace.
  const rows = triggersResp?.triggers ?? [];
  const live = new Map(rows.map((row) => [row.slug, row]));
  const absent = needs.triggers.filter((t) => !live.has(t.slug)).map((t) => t.slug);
  if (needs.triggers.length === 0) checks.push({ name: 'triggers', state: 'ok', detail: 'kortix.yaml declares no trigger' });
  else if (!triggersResp) checks.push({ name: 'triggers', state: 'fail', detail: 'cannot read the workspace triggers' });
  else if (absent.length) checks.push({ name: 'triggers', state: 'fail', detail: `not on the workspace yet: ${absent.join(', ')}`, fix: 'kortix ship', phase: 'ship' });
  else if (triggersResp.triggers_paused) checks.push({ name: 'triggers', state: 'warn', detail: 'live, but paused for the workspace', fix: 'kortix triggers resume' });
  else {
    const on = needs.triggers.filter((t) => live.get(t.slug)?.enabled).length;
    checks.push({ name: 'triggers', state: 'ok', detail: `${on} on, ${needs.triggers.length - on} off` });
  }

  // Sandbox templates: the build history is the truth; a template row can lag.
  for (const slug of needs.sandbox_templates) {
    const row = snapshots?.templates?.find((t) => t.slug === slug);
    const latest = (snapshots?.builds ?? []).find((b) => (b.template_slug ?? b.slug) === slug);
    if (row?.ready || latest?.status === 'ready') checks.push({ name: `sandbox ${slug}`, state: 'ok', detail: 'image built' });
    else if (latest?.status === 'building') checks.push({ name: `sandbox ${slug}`, state: 'fail', detail: 'build running', fix: `kortix sandboxes build ${slug} --wait`, phase: 'sandbox' });
    else checks.push({ name: `sandbox ${slug}`, state: 'fail', detail: latest?.status === 'failed' ? `last build failed: ${(latest.error ?? '').split('\n')[0]!.slice(0, 120)}` : 'not built yet', fix: `kortix sandboxes build ${slug} --wait`, phase: 'sandbox' });
  }

  // GitHub webhooks for GitHub-filtered webhook triggers.
  if (needs.github_webhooks.length > 0) {
    const problem = ghProblem();
    const listed = new Map<string, RepoHook[] | { error: string }>();
    const labelled = new Set<string>();
    for (const want of needs.github_webhooks) {
      const name = `webhook ${want.slug}`;
      // A trigger that filters on `body.repository.full_name` names its own repository.
      const repo = want.repo ?? ctx.repo;
      if (!repo) { checks.push({ name, state: 'fail', detail: 'no GitHub repository known', fix: 'pass --repo <owner/repo>, or filter the trigger on body.repository.full_name' }); continue; }
      if (problem) { checks.push({ name, state: 'warn', detail: `${problem}: cannot read the repository hooks`, fix: 'gh auth login' }); continue; }
      if (!listed.has(repo)) listed.set(repo, listHooks(repo));
      const hooks = listed.get(repo)!;
      if ('error' in hooks) { checks.push({ name, state: 'warn', detail: `gh cannot read the hooks of ${repo}`, fix: 'gh auth refresh -s admin:repo_hook' }); continue; }
      const url = live.get(want.slug)?.webhook_url ?? null;
      const hook = findHook(hooks, url);
      const missingEvents = hook ? want.events.filter((e) => !hook.events.includes(e) && !hook.events.includes('*')) : want.events;
      if (!hook) checks.push({ name, state: 'fail', detail: `no ${want.events.join(', ')} webhook on ${repo}`, fix: 'kortix onboard --yes', phase: 'webhooks' });
      else if (url && hook.url !== url) checks.push({ name, state: 'fail', detail: 'the webhook calls an old URL', fix: 'kortix onboard --yes', phase: 'webhooks' });
      else if (missingEvents.length) checks.push({ name, state: 'fail', detail: `events missing: ${missingEvents.join(', ')}`, fix: 'kortix onboard --yes', phase: 'webhooks' });
      else if (hook.last_code !== null && (hook.last_code < 200 || hook.last_code >= 300)) checks.push({ name, state: 'fail', detail: `last delivery answered ${hook.last_code}`, fix: 'kortix triggers runs ' + want.slug });
      else checks.push({ name, state: 'ok', detail: hook.last_code ? `last delivery ${hook.last_code}` : 'created, no delivery yet' });
      for (const other of foreignHooks(hooks, url, want.slug)) {
        checks.push({ name: `${name} (other workspace)`, state: 'warn', detail: `workspace ${other.workspace.slice(0, 8)} receives the same events from ${repo}: two workspaces would act on one event`, fix: `turn the trigger off in the other workspace, or delete its hook: gh api -X DELETE repos/${repo}/hooks/${other.id}` });
      }
      if (want.label && !labelled.has(`${repo} ${want.label}`)) {
        labelled.add(`${repo} ${want.label}`);
        if (!labelExists(repo, want.label)) checks.push({ name: `label ${want.label}`, state: 'fail', detail: `no label "${want.label}" on ${repo}`, fix: `gh label create ${want.label} --repo ${repo}`, phase: 'webhooks' });
      }
    }
  }

  // Connectors declared in kortix.yaml.
  for (const connector of needs.connectors) {
    const row = connectorsResp?.connectors.find((c) => c.slug === connector.slug);
    const state = row?.state ?? row?.status ?? 'absent';
    checks.push(
      state === 'connected' || state === 'active'
        ? { name: `connector ${connector.slug}`, state: 'ok', detail: 'connected' }
        : { name: `connector ${connector.slug}`, state: 'fail', detail: row ? state.replace('_', ' ') : 'not on the workspace yet', fix: `kortix connectors connect ${connector.slug}`, phase: row ? 'connectors' : 'ship' },
    );
  }

  if (needs.uses_slack) {
    checks.push(
      slack
        ? { name: 'slack', state: 'ok', detail: `connected${slack.workspaceName ? ` to ${slack.workspaceName}` : ''}` }
        : { name: 'slack', state: 'fail', detail: 'kortix.yaml uses Slack; the workspace has no Slack connection', fix: 'kortix channels connect', phase: 'slack' },
    );
  }

  const defaultModel = picker?.defaultModel;
  const runnable = defaultModel ? picker?.models?.[defaultModel]?.available !== false : false;
  checks.push(
    runnable
      ? { name: 'model', state: 'ok', detail: `${defaultModel}` }
      : { name: 'model', state: 'fail', detail: defaultModel ? `${defaultModel} is not connected` : 'no default model', fix: 'kortix providers login claude --start --share workspace' },
  );
  return checks;
}
