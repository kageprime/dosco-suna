/**
 * The Kortix side of `kortix plan`: signed in or not, the linked workspace,
 * the manifest, connectors, Slack, models. GET requests only; a failed read
 * is reported as `error`, never retried and never fatal.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ApiClient, ApiError, clientFromAuth } from '../api/client.ts';
import { activeHostName, defaultProject } from '../api/config.ts';
import type { ProjectSummary } from '../api/types.ts';
import { resolveProjectAuth } from '../command-helpers.ts';
import { loadLocalManifest } from '../manifest.ts';
import { projectIsManaged } from '../project-git.ts';
import { loadLink } from '../project-link.ts';
import { githubRepoFromRemote } from '../github-remote.ts';
import { manifestNeeds, type ManifestNeeds } from './manifest-needs.ts';

/**
 * Public repositories an agent reads and adapts: working examples of loops,
 * not something a command installs. Both are public since 2026-11-10.
 */
export const REFERENCE_REPOS = [
  { name: 'software-factory', url: 'https://github.com/kortix-ai/software-factory', summary: 'Issues, errors, logs and feedback become tickets, then reviewed pull requests.' },
  { name: 'marketing-factory', url: 'https://github.com/kortix-ai/marketing-factory', summary: 'Changelog, blog, social, AEO/SEO/GEO and performance reports as drafts a person approves.' },
] as const;

export interface KortixStateReport {
  signed_in: boolean;
  host: string | null;
  api_base: string | null;
  user: string | null;
  workspace: {
    id: string;
    source: 'link' | 'host default';
    name: string | null;
    github: { linked: boolean; repository: string | null } | null;
    error?: string;
  } | null;
  manifest: { file: string; imports: string[]; error?: string; needs: ManifestNeeds | null } | null;
  connectors: Array<{ slug: string; state: string }> | { error: string } | null;
  slack: { connected: boolean; team: string | null } | { error: string } | null;
  models: { default: string | null; available: number; default_available: boolean } | { error: string } | null;
}

const TIMEOUT_MS = 10_000;

async function read<T>(client: ApiClient, path: string): Promise<T | { error: string }> {
  try {
    return await Promise.race([
      client.get<T>(path),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
    ]);
  } catch (err) {
    return { error: err instanceof ApiError ? `HTTP ${err.status}` : (err as Error).message };
  }
}

function failed(value: unknown): value is { error: string } {
  return !!value && typeof value === 'object' && 'error' in value && typeof (value as { error: unknown }).error === 'string' && Object.keys(value).length === 1;
}

export function readManifestState(root: string): KortixStateReport['manifest'] {
  const file = ['kortix.yaml', 'kortix.yml'].find((name) => existsSync(join(root, name)));
  if (!file) return null;
  try {
    const manifest = loadLocalManifest(root);
    const data = manifest?.data ?? {};
    const imports = Array.isArray(data.imports) ? data.imports.filter((p): p is string => typeof p === 'string') : [];
    return { file, imports, needs: manifestNeeds(data, root) };
  } catch (err) {
    return { file, imports: [], error: (err as Error).message.split('\n')[0]!, needs: null };
  }
}

export async function readKortixState(root: string): Promise<KortixStateReport> {
  const { hostName, auth } = resolveProjectAuth();
  const manifest = readManifestState(root);
  const report: KortixStateReport = {
    signed_in: !!auth?.token,
    host: hostName ?? activeHostName(),
    api_base: auth?.api_base ?? null,
    user: auth?.user_email || null,
    workspace: null,
    manifest,
    connectors: null,
    slack: null,
    models: null,
  };
  const link = loadLink(root);
  const fallback = link ? null : defaultProject();
  const workspaceId = link?.project_id ?? fallback?.project_id ?? null;
  if (workspaceId) report.workspace = { id: workspaceId, source: link ? 'link' : 'host default', name: null, github: null };
  if (!auth?.token || !report.workspace) return report;

  const client = clientFromAuth(auth);
  const base = `/workspaces/${workspaceId}`;
  const [summary, connectors, slack, picker] = await Promise.all([
    read<ProjectSummary>(client, base),
    read<{ connectors: Array<{ slug: string; state?: string; status?: string }> }>(client, `/connectors${base}/connectors?include_schemas=false`),
    read<{ workspaceName?: string | null } | null>(client, `${base}/channels/slack/installation`),
    read<{ models?: Record<string, { available?: boolean }>; defaultModel?: string }>(client, `${base}/model-picker`),
  ]);
  if (failed(summary)) report.workspace.error = summary.error;
  else {
    const managed = projectIsManaged(summary);
    report.workspace.name = summary.name ?? null;
    const repository = managed ? null : githubRepoFromRemote(summary.repo_url ?? '');
    report.workspace.github = { linked: repository !== null, repository };
  }
  report.connectors = failed(connectors) ? connectors : connectors.connectors.map((c) => ({ slug: c.slug, state: c.state ?? c.status ?? 'unknown' }));
  report.slack = failed(slack) ? slack : { connected: !!slack, team: slack?.workspaceName ?? null };
  if (failed(picker)) report.models = picker;
  else {
    const models = Object.values(picker.models ?? {});
    const def = picker.defaultModel ?? null;
    report.models = { default: def, available: models.filter((m) => m.available !== false).length, default_available: !!def && picker.models?.[def]?.available !== false };
  }
  return report;
}
