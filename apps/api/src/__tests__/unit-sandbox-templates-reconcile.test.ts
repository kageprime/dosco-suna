/**
 * POST /v1/projects/:id/sandbox-templates/reconcile — `kortix ship` calls it
 * after its push. 2026-11-10: a workspace linked to GitHub declared
 * `sandbox.templates: [{ slug: dev, dockerfile: ... }]` in the commit ship
 * pushed; project create had read the tip before that push, nothing built
 * `dev`, and every session booted the platform default image.
 *
 * The route runs for real down to the provider seam: the mirror refresh, the
 * template list and identity, the provider state and the build start are
 * observed instead of executed (no git, no provider contact).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';

let capabilityDenied = false;
let refreshFails = false;
const refreshes: Array<{ force: unknown }> = [];
const builds: Array<{ slug?: string; provider?: string; source?: string }> = [];
let providerStates: Record<string, string> = {};
let identityFailures = new Set<string>();

const template = (slug: string, isShared = false) => ({ slug, isShared, templateId: `tpl-${slug}` });
let templates = [template('default', true), template('dev'), template('gpu')];

const actualAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...actualAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID, metadata: {} },
  }),
  assertProjectCapability: async () => {
    if (capabilityDenied) throw Object.assign(new Error('Forbidden'), { status: 403 });
  },
}));

const actualLibGit = await import('../projects/lib/git');
mock.module('../projects/lib/git', () => ({
  ...actualLibGit,
  loadGitProject: async () => ({ projectId: PROJECT_ID }),
}));

const actualMirror = await import('../projects/git/mirror');
mock.module('../projects/git/mirror', () => ({
  ...actualMirror,
  refreshMirror: async (_project: unknown, force: unknown) => {
    refreshes.push({ force });
    if (refreshFails) throw new Error('upstream unreachable');
    return '/nonexistent-mirror';
  },
}));

const actualTemplates = await import('../snapshots/templates');
mock.module('../snapshots/templates', () => ({
  ...actualTemplates,
  listTemplatesForProject: async () => templates,
  computeTemplateIdentity: async (_project: unknown, t: { slug: string }) => {
    if (identityFailures.has(t.slug)) throw new Error(`Dockerfile for ${t.slug} not found at the base branch`);
    return { snapshotName: `kortix-tpl-${t.slug}` };
  },
}));

const actualCoverage = await import('../snapshots/provider-coverage');
mock.module('../snapshots/provider-coverage', () => ({
  ...actualCoverage,
  enabledTemplateBuildProviders: () => ['platinum'],
}));

const actualProviders = await import('../snapshots/providers');
mock.module('../snapshots/providers', () => ({
  ...actualProviders,
  getSandboxProvider: () => ({
    getSnapshotState: async (name: string) => providerStates[name] ?? 'missing',
  }),
}));

const actualBuilder = await import('../snapshots/builder');
mock.module('../snapshots/builder', () => ({
  ...actualBuilder,
  ensureSandboxImage: async (_project: unknown, opts: { slug?: string; provider?: string; source?: string }) => {
    builds.push({ slug: opts.slug, provider: opts.provider, source: opts.source });
  },
}));

const { projectsApp } = await import('../projects/lib/app');
const { registerSandboxTemplatesRoutes } = await import('../projects/routes/sandbox-templates');
registerSandboxTemplatesRoutes();

function reconcile() {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 500) as 403));
  app.use('/v1/projects/*', async (c: any, next) => {
    c.set('userId', USER_ID);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app.request(`/v1/projects/${PROJECT_ID}/sandbox-templates/reconcile`, { method: 'POST' });
}

describe('POST /v1/projects/:id/sandbox-templates/reconcile', () => {
  beforeEach(() => {
    capabilityDenied = false;
    refreshFails = false;
    refreshes.length = 0;
    builds.length = 0;
    providerStates = {};
    identityFailures = new Set();
    templates = [template('default', true), template('dev'), template('gpu')];
  });

  test('fetches the upstream, starts a build of each project template with no image, and names each one', async () => {
    providerStates = { 'kortix-tpl-gpu': 'active' };
    const res = await reconcile();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(refreshes).toEqual([{ force: true }]);
    expect(body.started).toBe(1);
    expect(body.templates).toEqual([
      { slug: 'dev', snapshot_name: 'kortix-tpl-dev', state: 'building', error: null, providers: [{ provider: 'platinum', state: 'missing', started: true }] },
      { slug: 'gpu', snapshot_name: 'kortix-tpl-gpu', state: 'ready', error: null, providers: [{ provider: 'platinum', state: 'active', started: false }] },
    ]);
    // The build starts in the background; the platform default is never built from a project.
    await Bun.sleep(0);
    expect(builds).toEqual([{ slug: 'dev', provider: 'platinum', source: 'manual' }]);
  });

  test('a build already running is reported as building and not started again', async () => {
    providerStates = { 'kortix-tpl-dev': 'building', 'kortix-tpl-gpu': 'active' };
    const body = await (await reconcile()).json();
    expect(body.started).toBe(0);
    expect(body.templates[0]).toMatchObject({ slug: 'dev', state: 'building', providers: [{ state: 'building', started: false }] });
    await Bun.sleep(0);
    expect(builds).toEqual([]);
  });

  test('a template whose identity cannot be computed is reported with the reason, the others still build', async () => {
    identityFailures = new Set(['dev']);
    const body = await (await reconcile()).json();
    expect(body.templates[0]).toEqual({ slug: 'dev', snapshot_name: null, state: 'error', error: 'Dockerfile for dev not found at the base branch', providers: [] });
    expect(body.templates[1]).toMatchObject({ slug: 'gpu', state: 'building' });
    await Bun.sleep(0);
    expect(builds.map((b) => b.slug)).toEqual(['gpu']);
  });

  test('an unreachable upstream answers 502 and starts nothing', async () => {
    refreshFails = true;
    const res = await reconcile();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('upstream unreachable');
    expect(builds).toEqual([]);
  });

  test('a caller without project.sandbox.write is refused and nothing is fetched or built', async () => {
    capabilityDenied = true;
    const res = await reconcile();
    expect(res.status).toBe(403);
    expect(refreshes).toEqual([]);
    expect(builds).toEqual([]);
  });
});
