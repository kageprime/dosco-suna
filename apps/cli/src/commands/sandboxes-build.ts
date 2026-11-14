/**
 * Cloud builds of the workspace's sandbox templates: start the builds that
 * kortix.yaml asks for (`kortix ship`), and follow one build to its end
 * (`kortix sandboxes build <slug> --wait`).
 *
 * Mirrors apps/api `POST /workspaces/:id/sandbox-templates/reconcile` and
 * `GET /workspaces/:id/snapshots`.
 */
import { type ApiClient, ApiError } from '../api/client.ts';
import { C, status, trim } from '../style.ts';

/** One provider's answer in a reconcile. */
export interface ReconcileProvider {
  provider: string;
  state: string;
  started: boolean;
}

/** One project template after a reconcile. */
export interface ReconciledTemplate {
  slug: string;
  snapshot_name: string | null;
  state: 'ready' | 'building' | 'error';
  error: string | null;
  providers: ReconcileProvider[];
}

interface SnapshotsBody {
  templates?: Array<{ slug: string; ready: boolean }>;
  builds?: Array<{
    build_id: string;
    slug: string;
    template_slug?: string | null;
    status: 'building' | 'ready' | 'failed';
    error: string | null;
    error_category?: string | null;
    provider?: string | null;
  }>;
}

/**
 * Read kortix.yaml at the workspace's base branch tip and start a build of
 * every project template whose image is missing. `null` when this host has
 * no reconcile route (an API older than it).
 */
export async function reconcileTemplates(client: ApiClient, base: string): Promise<ReconciledTemplate[] | null> {
  try {
    const resp = await client.post<{ templates?: ReconciledTemplate[] }>(`${base}/sandbox-templates/reconcile`);
    return Array.isArray(resp?.templates) ? resp.templates : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The project templates kortix.yaml declares (`sandbox.templates[].slug`), the platform default excluded. */
export function declaredTemplateSlugs(data: Record<string, unknown> | null | undefined): string[] {
  const sandbox = data?.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return [];
  const templates = (sandbox as Record<string, unknown>).templates;
  if (!Array.isArray(templates)) return [];
  return templates
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>).slug : undefined))
    .filter((slug): slug is string => typeof slug === 'string' && slug.trim() !== '' && slug !== 'default');
}

/** One line per template: ready, building (with the wait command) or the error. */
export function writeReconcileLines(templates: ReconciledTemplate[]): void {
  for (const t of templates) {
    if (t.state === 'ready') {
      process.stdout.write(`  ${status.ok(`sandbox ${C.bold}${t.slug}${C.reset} ready`)}\n`);
    } else if (t.state === 'building') {
      const started = t.providers.filter((p) => p.started).map((p) => p.provider);
      const what = started.length > 0 ? `build started on ${started.join(', ')}` : 'build running';
      process.stdout.write(
        `  ${status.ok(`sandbox ${C.bold}${t.slug}${C.reset} ${what}`)} ${C.dim}— wait for it: ${C.reset}${C.cyan}kortix sandboxes build ${t.slug} --wait${C.reset}\n`,
      );
    } else {
      process.stdout.write(`  ${status.warn(`sandbox ${t.slug} not built: ${trim((t.error ?? 'unknown error').split('\n')[0]!, 100)}`)}\n`);
    }
  }
}

const POLL_START_MS = 1_000;
const POLL_MAX_MS = 5_000;

/**
 * Follow the build of `slug` until its template is ready (0), a build that
 * was not in `knownBuildIds` fails (1), or `timeoutSec` passes (1). The build
 * itself runs on the server; this only reads `GET /snapshots`.
 */
export async function waitForTemplate(
  client: ApiClient,
  base: string,
  slug: string,
  opts: { knownBuildIds: Set<string>; timeoutSec: number; json: boolean; silent?: boolean },
): Promise<number> {
  const deadline = Date.now() + Math.max(0, opts.timeoutSec) * 1000;
  let delay = POLL_START_MS;
  let lastLine = '';
  for (;;) {
    const body = await client.get<SnapshotsBody>(`${base}/snapshots`);
    const template = body.templates?.find((t) => t.slug === slug);
    const ours = (body.builds ?? []).filter(
      (b) => (b.template_slug ?? b.slug) === slug && !opts.knownBuildIds.has(b.build_id),
    );
    const failed = ours.find((b) => b.status === 'failed');
    if (template?.ready) {
      if (opts.silent) return 0;
      if (opts.json) process.stdout.write(`${JSON.stringify({ slug, state: 'ready' })}\n`);
      else process.stdout.write(`${status.ok(`Sandbox template ${C.bold}${slug}${C.reset} is ready`)}\n`);
      return 0;
    }
    if (failed) {
      if (opts.silent) return 1;
      if (opts.json) process.stdout.write(`${JSON.stringify({ slug, state: 'failed', build: failed })}\n`);
      else {
        process.stderr.write(`${status.err(`Build of ${slug} failed${failed.provider ? ` on ${failed.provider}` : ''}`)}\n`);
        if (failed.error) process.stderr.write(`  ${failed.error.split('\n').slice(0, 5).join('\n  ')}\n`);
        process.stderr.write(`  ${C.dim}Repair it with ${C.reset}${C.cyan}kortix sandboxes fix${C.reset}\n`);
      }
      return 1;
    }
    if (!opts.json && !opts.silent) {
      const line = ours.some((b) => b.status === 'building') ? 'building' : 'waiting for the build to start';
      if (line !== lastLine) process.stdout.write(`  ${C.dim}${slug}: ${line}${C.reset}\n`);
      lastLine = line;
    }
    if (Date.now() >= deadline) {
      const message = `Sandbox template ${slug} is not ready after ${opts.timeoutSec}s; the build continues on the server. Check it with \`kortix sandboxes builds\`.`;
      if (opts.silent) return 1;
      if (opts.json) process.stdout.write(`${JSON.stringify({ slug, state: 'timeout' })}\n`);
      else process.stderr.write(`${status.err(message)}\n`);
      return 1;
    }
    await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

/** The build IDs `GET /snapshots` lists now: a failure among them is not this build's. */
export async function currentBuildIds(client: ApiClient, base: string): Promise<Set<string>> {
  const body = await client.get<SnapshotsBody>(`${base}/snapshots`);
  return new Set((body.builds ?? []).map((b) => b.build_id));
}
