/**
 * KRTX-4465 regression guard for POST /v1/projects/:id/snapshots/rebuild.
 *
 * The handler authorizes the caller only against the project in the path and
 * then hands the caller-supplied slug to deleteSandboxImage. The "default"
 * slug short-circuits to the shared, project-independent platform row
 * (resolveTemplateBySlug → resolveDefaultTemplate), so a project-scoped
 * caller holding project.sandbox.write on ANY one project could delete the
 * one shared image every tenant's next session boots from — and a provider
 * that refuses while sandboxes are pinned answered a 409 disclosing the
 * cross-tenant in-use count on the way. The handler must refuse the shared
 * rows for project-scoped callers and keep the ability for platform admins.
 *
 * The routes run over a shimmed db; the REAL resolveTemplateForBuildSlug runs
 * so the slug → shared-row mapping is exercised, and deleteSandboxImage is
 * observed instead of executed (no provider contact).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { sandboxTemplates } from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SHARED_ROW = {
  templateId: '00000000-0000-4000-a000-000000000301',
  projectId: null,
  slug: 'default',
  name: 'Platform default',
  isShared: true,
  source: 'platform',
  provider: 'platinum',
  image: null,
  dockerfilePath: null,
  entrypoint: null,
  cpu: 2,
  memoryGb: 4,
  diskGb: 10,
  containerRuntime: false,
  metadata: {},
  providerState: 'active',
  providerSnapshotName: 'snap-shared',
  contentHash: 'hash-shared',
  builtFromCommit: null,
  swapKey: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const PROJECT_ROW = {
  ...SHARED_ROW,
  templateId: '00000000-0000-4000-a000-000000000302',
  projectId: PROJECT_ID,
  slug: 'custom',
  isShared: false,
  source: 'ui',
  providerState: 'active',
  providerSnapshotName: 'snap-custom',
  contentHash: 'hash-custom',
};

let platformAdmin = false;
let callerUserId = USER_ID;
let sessionPrincipal = false;
const deleteCalls: Array<{ slug?: string; provider?: string; template?: { slug: string } }> = [];

// The guard consults the caller's platform role. Overridden per test.
const actualPlatformRoles = await import('../shared/platform-roles');
mock.module('../shared/platform-roles', () => ({
  ...actualPlatformRoles,
  isPlatformAdmin: async () => platformAdmin,
}));

// Project access: the rebuild route's own capability gate is bypassed (it is
// not what this suite pins); the loaded row feeds the handler.
const actualAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...actualAccess,
  loadProjectForUser: async () => ({
    userId: callerUserId,
    row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID, metadata: {} },
  }),
  assertProjectCapability: async () => {},
}));

const actualLibGit = await import('../projects/lib/git');
mock.module('../projects/lib/git', () => ({
  ...actualLibGit,
  loadGitProject: async () => ({ projectId: PROJECT_ID }),
}));

// Keep the manifest sync a no-op (no git): readManifest answers null and the
// sync's db reads fall through the shim below.
const actualTriggers = await import('../projects/triggers');
mock.module('../projects/triggers', () => ({
  ...actualTriggers,
  readManifest: async () => null,
}));

// db shim for the REAL resolve path:
// - resolveDefaultTemplate reads `sandboxTemplates` through `.limit(1)` → the
//   shared row;
// - listTemplatesForProject awaits `.where(...)` directly → shared + project rows.
// Every other table answers empty.
mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === sandboxTemplates ? [SHARED_ROW, PROJECT_ROW] : [];
          const out = Promise.resolve(rows) as Promise<typeof rows> & { limit: () => Promise<typeof rows> };
          out.limit = async () => (table === sandboxTemplates ? [SHARED_ROW] : []);
          return out;
        },
      }),
    }),
  },
}));

// Observe (not execute) the provider-side delete. Unknown slugs reproduce the
// real resolve's TemplateNotFoundError so the 404 mapping stays pinned both
// before and after the guard. The authorized `template` the rebuild handler
// passes through is recorded too (the check/use closure).
const { TemplateNotFoundError } = await import('../snapshots/templates');
const actualBuilder = await import('../snapshots/builder');
const kickCalls: Array<{ slug?: string; source?: string }> = [];
mock.module('../snapshots/builder', () => ({
  ...actualBuilder,
  deleteSandboxImage: async (_project: unknown, opts: { slug?: string; provider?: string; template?: { slug: string } }) => {
    const slug = (opts.slug ?? '').trim() || 'default';
    if (slug !== 'default' && slug !== 'custom') throw new TemplateNotFoundError(slug);
    deleteCalls.push({ slug: opts.slug, provider: opts.provider, template: opts.template });
    return { deleted: true, snapshotName: `snap-${slug}`, slug };
  },
  kickPreBuild: () => {},
  kickRoutedPreBuild: (_project: unknown, opts: { slug?: string; source?: string }) => {
    kickCalls.push({ ...opts });
  },
  templateBuildProviders: () => ['platinum'],
}));

const { projectsApp } = await import('../projects/lib/app');
const { registerSandboxesRoutes } = await import('../projects/routes/sandboxes');
const { registerSandboxTemplatesRoutes } = await import('../projects/routes/sandbox-templates');
registerSandboxesRoutes();
registerSandboxTemplatesRoutes();

function createApp() {
  const app = new Hono();
  app.use('/v1/projects/*', async (c: any, next) => {
    c.set('userId', callerUserId);
    // The session-principal shape the auth middleware would set for an
    // in-sandbox agent session: a session binding on the context.
    if (sessionPrincipal) c.set('sessionId', 'sess-test-principal');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function rebuild(body: Record<string, unknown>) {
  return createApp().request(`/v1/projects/${PROJECT_ID}/snapshots/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/projects/:id/snapshots/rebuild refuses the shared platform image (KRTX-4465)', () => {
  beforeEach(() => {
    platformAdmin = false;
    callerUserId = USER_ID;
    sessionPrincipal = false;
    deleteCalls.length = 0;
    kickCalls.length = 0;
  });

  test('a project-scoped caller rebuilding the implicit default gets 403 and the shared image is not deleted', async () => {
    const res = await rebuild({});
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_SHARED');
    expect(deleteCalls).toHaveLength(0);
  });

  test('a project-scoped caller rebuilding slug=default gets 403 and the shared image is not deleted', async () => {
    const res = await rebuild({ slug: 'default' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_SHARED');
    expect(deleteCalls).toHaveLength(0);
  });

  test('a project-scoped caller cannot reach the shared image through a warm build slug (default-warm)', async () => {
    const res = await rebuild({ slug: 'default-warm' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_SHARED');
    expect(deleteCalls).toHaveLength(0);
  });

  test('a platform admin keeps the ability to rebuild the shared default', async () => {
    platformAdmin = true;
    const res = await rebuild({ slug: 'default' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.slug).toBe('default');
    expect(deleteCalls).toHaveLength(1);
    // The delete runs against the template the guard resolved (the check/use
    // closure): never a re-resolve of the raw slug.
    expect(deleteCalls[0].slug).toBe('default');
    expect(deleteCalls[0].provider).toBe('platinum');
    expect(deleteCalls[0].template?.slug).toBe('default');
  });

  test('an explicit project slug still rebuilds for a project-scoped caller', async () => {
    const res = await rebuild({ slug: 'custom' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.slug).toBe('custom');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].slug).toBe('custom');
    expect(deleteCalls[0].provider).toBe('platinum');
    expect(deleteCalls[0].template?.slug).toBe('custom');
  });

  test('a slug naming no template still answers 404 TEMPLATE_NOT_FOUND', async () => {
    const res = await rebuild({ slug: 'nope' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_NOT_FOUND');
    expect(deleteCalls).toHaveLength(0);
  });

  test('a project-session principal never counts as the platform-admin operator, even with an admin userId', async () => {
    // An in-sandbox agent session carries its launcher's userId: a platform
    // admin's session token would pass isPlatformAdmin alone (KRTX-4465,
    // Strix CWE-863). The session principal is refused like any other
    // project-scoped caller.
    platformAdmin = true;
    sessionPrincipal = true;
    const res = await rebuild({ slug: 'default' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_SHARED');
    expect(deleteCalls).toHaveLength(0);
  });
});

describe('POST /v1/projects/:id/sandbox-templates/:templateId/build refuses the shared platform image (KRTX-4465)', () => {
  beforeEach(() => {
    platformAdmin = false;
    callerUserId = USER_ID;
    sessionPrincipal = false;
    deleteCalls.length = 0;
    kickCalls.length = 0;
  });

  function build(templateId: string) {
    return createApp().request(`/v1/projects/${PROJECT_ID}/sandbox-templates/${templateId}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  }

  test('a project-scoped caller building the shared platform template gets 403 and no build starts', async () => {
    const res = await build(SHARED_ROW.templateId);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_SHARED');
    expect(kickCalls).toHaveLength(0);
  });

  test('a platform admin keeps the ability to build the shared template', async () => {
    platformAdmin = true;
    const res = await build(SHARED_ROW.templateId);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.slug).toBe('default');
    expect(kickCalls).toHaveLength(1);
  });

  test('a project-session principal never counts as the platform-admin operator on the build route either', async () => {
    platformAdmin = true;
    sessionPrincipal = true;
    const res = await build(SHARED_ROW.templateId);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('TEMPLATE_SHARED');
    expect(kickCalls).toHaveLength(0);
  });
});
