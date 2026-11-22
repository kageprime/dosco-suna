import { type GitBackedProject } from '../projects/git';
import { getSandboxProvider } from './providers';
import { config, type SandboxProviderName } from '../config';
import { computeTemplateIdentity, listTemplatesForProject, resolveTemplateForBuildSlug, refreshTemplateState, type ResolvedTemplate } from './templates';
import { enabledTemplateBuildProviders, observeTemplateProviderCoverage, resolveRoutedTemplateState, type SandboxTemplateProvider, type SandboxTemplateProviderCoverage } from './provider-coverage';
import { ensureSandboxImage, type SnapshotBuildSource } from './builder';
import { logger } from '../lib/logger';
import { shouldReconcileProviderState } from './builder-log';
import type { ProviderState } from './providers';

/**
 * Fire-and-forget pre-build. Used at project-create and CR-merge time so the
 * first session for a new commit can boot off a cache hit.
 */
export function kickPreBuild(
  project: GitBackedProject,
  opts: { slug?: string; accountId: string; source: SnapshotBuildSource; provider?: string },
): void {
  fireAndForget(
    ensureSandboxImage(project, opts),
    `[snapshots] pre-build failed for ${project.projectId} (slug=${opts.slug ?? 'default'}, ${opts.source}):`,
  );
}

/** Run `work` unawaited; a rejection warns with `message` instead of surfacing. */
function fireAndForget(work: Promise<unknown>, message: string): void {
  void work.catch((err) => console.warn(message, err instanceof Error ? err.message : err));
}

/** Providers a project can route a new session to for proactive template builds. */
export function templateBuildProviders(): SandboxTemplateProvider[] {
  return enabledTemplateBuildProviders({
    allowed: config.ALLOWED_SANDBOX_PROVIDERS,
    isEnabled: (provider) => config.isProviderEnabled(provider as SandboxProviderName),
  });
}

/** Fire the same content-addressed build independently on every routed provider. */
export function kickRoutedPreBuild(
  project: GitBackedProject,
  opts: {
    slug?: string;
    accountId: string;
    source: SnapshotBuildSource;
  },
): void {
  for (const provider of templateBuildProviders()) {
    kickPreBuild(project, {
      slug: opts.slug,
      accountId: opts.accountId,
      source: opts.source,
      provider,
    });
  }
}
// ─── Custom (toml / UI) templates — explicit rebuilds ────────────────────────

/** One provider's answer for one template in {@link reconcileProjectTemplates}. */
export interface TemplateReconcileProvider {
  provider: SandboxTemplateProvider;
  /** The provider's image state before this reconcile. */
  state: ProviderState;
  /** True when this reconcile started a build on the provider. */
  started: boolean;
}

/** One project template after {@link reconcileProjectTemplates}. */
export interface TemplateReconcileResult {
  slug: string;
  snapshot_name: string | null;
  /** `ready`: built on every provider that answered. `building`: a build runs or was started. `error`: see `error`. */
  state: 'ready' | 'building' | 'error';
  error: string | null;
  providers: TemplateReconcileProvider[];
}

/**
 * Reconcile a project's OWN templates (never the shared default): for each
 * custom template whose built image is stale or missing relative to its
 * currently-computed identity, kick a pre-build. Driven by project-create,
 * CR-merge and `kortix ship` (`POST .../sandbox-templates/reconcile`) so a
 * Dockerfile or spec change lands a fresh image proactively instead of
 * stalling the next session that boots the slug. Forces a manifest sync so a
 * `sandbox.templates` edit in the just-pushed commit is picked up. The builds
 * run in the background; the result names what each provider holds.
 */
export async function reconcileProjectTemplates(
  project: GitBackedProject,
  opts: { accountId: string; source: SnapshotBuildSource },
): Promise<{ checked: number; rebuilt: number; templates: TemplateReconcileResult[] }> {
  const templates = await listTemplatesForProject(project, { forceTomlSync: true });
  const providers = templateBuildProviders();
  let rebuilt = 0;
  const results: TemplateReconcileResult[] = [];
  for (const t of templates) {
    if (t.isShared) continue; // the platform default is built globally
    let identity: Awaited<ReturnType<typeof computeTemplateIdentity>>;
    try {
      identity = await computeTemplateIdentity(project, t);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[snapshots] reconcile: cannot compute identity for ${project.projectId}/${t.slug}:`, message);
      results.push({ slug: t.slug, snapshot_name: null, state: 'error', error: message, providers: [] });
      continue;
    }
    const answers: TemplateReconcileProvider[] = [];
    for (const providerId of providers) {
      const provider = getSandboxProvider(providerId);
      // A provider that cannot answer (bad credentials, an outage) is reported
      // as `unknown` and gets no build: it must not fail the reconcile of the
      // providers that work.
      let state: ProviderState;
      try {
        state = await provider.getSnapshotState(identity.snapshotName);
      } catch (err) {
        logger.warn('[snapshots] reconcile: a provider cannot report a template image', {
          provider: providerId,
          projectId: project.projectId,
          slug: t.slug,
          error: err instanceof Error ? err.message : String(err),
        });
        answers.push({ provider: providerId, state: 'unknown', started: false });
        continue;
      }
      const started = state !== 'active' && shouldReconcileProviderState(state);
      if (started) {
        kickPreBuild(project, {
          slug: t.slug,
          accountId: opts.accountId,
          source: opts.source,
          provider: providerId,
        });
        rebuilt += 1;
      }
      answers.push({ provider: providerId, state, started });
    }
    const reachable = answers.filter((a) => a.state !== 'unknown');
    results.push({
      slug: t.slug,
      snapshot_name: identity.snapshotName,
      state: reachable.length > 0 && reachable.every((a) => a.state === 'active') ? 'ready' : 'building',
      error: null,
      providers: answers,
    });
  }
  return { checked: templates.length, rebuilt, templates: results };
}

/** Fire-and-forget wrapper around {@link reconcileProjectTemplates}. */
export function kickProjectTemplatePrebuilds(
  project: GitBackedProject,
  opts: { accountId: string; source: SnapshotBuildSource },
): void {
  fireAndForget(
    reconcileProjectTemplates(project, opts),
    `[snapshots] project-template reconcile failed for ${project.projectId} (${opts.source}):`,
  );
}

/**
 * Force the next session to rebuild by deleting the provider-side snapshot
 * for a given slug. No-op if nothing is there.
 *
 * Accepts a BUILD slug (`default-warm`) as well as a template slug: the retry
 * surfaces hand us whatever `latest_failure.slug` held, and the warm bake's build
 * row is never a template. Deleting the base template's snapshot is the correct
 * response either way — the warm image is re-baked from it.
 */
export async function deleteSandboxImage(
  project: GitBackedProject,
  opts:
    | { /** Exact provider identity to drop; its provider is required. */ snapshotName: string; provider: string; slug?: string }
    | { slug?: string; provider?: string; template?: ResolvedTemplate }
    = {},
): Promise<{ deleted: boolean; snapshotName: string; slug: string }> {
  let target: { providerId: string; snapshotName: string; slug: string; templateId?: string | null };
  if ('snapshotName' in opts) {
    // A caller holding the EXACT provider identity to drop (the session heal:
    // the snapshot name the session actually booted) passes `snapshotName`:
    // delete that name and never re-derive it from a slug — a project template
    // named `default-warm` that disappears mid-provision would otherwise fall
    // back to the shared platform default and make the heal delete the image
    // every tenant's next session boots from (KRTX-4465, Strix CWE-367).
    target = { providerId: opts.provider, snapshotName: opts.snapshotName, slug: opts.slug ?? '' };
  } else {
    // A caller that ALREADY resolved the template (the rebuild route's guard
    // authorizes the resolved row before reaching here) passes it back: delete
    // exactly that identity, never re-resolve the raw slug — a project row that
    // disappears between the caller's resolve and this one would fall back to
    // the shared platform default (the check/use window, KRTX-4465).
    const template = opts.template ?? await resolveTemplateForBuildSlug(project, opts.slug);
    const identity = await computeTemplateIdentity(project, template);
    target = {
      providerId: opts.provider ?? template.provider,
      snapshotName: identity.snapshotName,
      slug: template.slug,
      templateId: template.templateId,
    };
  }
  const provider = getSandboxProvider(target.providerId);
  const before = await provider.getSnapshotState(target.snapshotName);
  await provider.deleteSnapshot(target.snapshotName);
  // Reflect on the template row.
  if (target.templateId) {
    try {
      await refreshTemplateState(target.templateId);
    } catch {
      /* best-effort */
    }
  }
  return {
    deleted: before === 'active' || before === 'building',
    snapshotName: target.snapshotName,
    slug: target.slug,
  };
}


/** Stateless view of every template available to the project + live state. */
export interface SandboxTemplateView {
  templateId: string | null;
  slug: string;
  name: string;
  isDefault: boolean;
  source: 'platform' | 'toml' | 'ui';
  hasDockerfile: boolean;
  hasImage: boolean;
  image: string | null;
  dockerfilePath: string | null;
  entrypoint: string | null;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  snapshotName: string;
  contentHash: string;
  daytonaState: string;
  providerState: string;
  ready: boolean;
  provider: string;
  builtFromCommit: string | null;
  /** Fresh launch-readiness observations for this exact content identity. */
  providerCoverage?: SandboxTemplateProviderCoverage[];
  /** `residential_proxy`; null = off. */
  residentialProxy: ResolvedTemplate['residentialProxy'];
}

export async function listSandboxTemplates(
  project: GitBackedProject,
  opts: {
    /** Explicit project pin. null means Automatic routing across enabled providers. */
    selectedProvider?: SandboxTemplateProvider | null;
    includeProviderCoverage?: boolean;
  } = {},
): Promise<SandboxTemplateView[]> {
  const items = await listTemplatesForProject(project);
  const results = await Promise.allSettled(items.map((t) => toView(project, t, opts)));
  const views: SandboxTemplateView[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      views.push(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[sandbox-templates] skipping template "${items[i]!.slug}": ${reason}`);
    }
  }
  return views;
}

async function toView(
  project: GitBackedProject,
  t: ResolvedTemplate,
  opts: {
    selectedProvider?: SandboxTemplateProvider | null;
    includeProviderCoverage?: boolean;
  },
): Promise<SandboxTemplateView> {
  // Listings already opt into bounded stale mirror reads. Do not override
  // that policy with the build path's forced tip proof for a Dockerfile.
  const identity = await computeTemplateIdentity(project, t, { freshness: false });
  let state: string = t.providerState ?? 'missing';
  let providerCoverage: SandboxTemplateProviderCoverage[] | undefined;
  if (opts.includeProviderCoverage) {
    providerCoverage = await observeTemplateProviderCoverage(identity.snapshotName, {
      isProviderEnabled: (provider) => config.isProviderEnabled(provider),
      getProvider: (provider) => getSandboxProvider(provider),
      now: () => new Date(),
    });
    state = resolveRoutedTemplateState(providerCoverage, opts.selectedProvider ?? null);
  } else {
    try {
      const provider = getSandboxProvider(t.provider);
      if (provider.isConfigured()) {
        state = await provider.getSnapshotState(identity.snapshotName);
      }
    } catch {
      /* keep cached */
    }
  }
  return {
    templateId: t.templateId,
    slug: t.slug,
    name: t.name,
    isDefault: t.isShared,
    source: t.source,
    hasDockerfile: !!t.dockerfilePath || !!t.dockerfileInline,
    hasImage: !!t.image,
    image: t.image,
    dockerfilePath: t.dockerfilePath,
    entrypoint: t.entrypoint,
    cpu: t.cpu,
    memoryGb: t.memoryGb,
    diskGb: t.diskGb,
    snapshotName: identity.snapshotName,
    contentHash: identity.contentHash,
    daytonaState: state,
    providerState: state,
    ready: state === 'active',
    provider: t.provider,
    builtFromCommit: t.builtFromCommit,
    residentialProxy: t.residentialProxy,
    ...(providerCoverage ? { providerCoverage } : {}),
  };
}
