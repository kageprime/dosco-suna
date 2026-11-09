/**
 * Characterization: GET /:workspaceId/detail — the bundle the settings pages
 * read. Pins the whole pipeline of the handler so a restructure (the split
 * into `project-detail-config.ts`) never moves behavior:
 *
 *   - snapshot source: the saved config summary answers, files from the saved
 *     list (complete) or refreshed from git (past the stored path cap),
 *   - live source: no saved summary → git loads config + files, header `live`,
 *   - the one git failure mode per branch: a disconnected repository renders
 *     the shell (repository_disconnected health, no files), an unavailable
 *     listing warns and answers with an empty list (`unavailable` header),
 *   - per-capability section filtering (file/skill reads),
 *   - the feature-flag filter on listed skills,
 *   - the resource-grant visibility denier (config lists + the raw file list).
 *
 * The suite runs the REAL handler on the shared `projectsApp` with its DB- and
 * git-touching collaborators faked (`mock.module` is process-global in
 * bun:test, so this lives in its own file, like project-detail-last-opened).
 * Everything must keep passing before AND after the move unchanged.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectConfigSummary, ProjectFileEntry } from '../git/types';
import { manifestHealthOf } from '../lib/manifest-health';

const PROJECT_ID = '00000000-0000-4000-a000-0000000270a0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000270a1';
const USER_ID = '00000000-0000-4000-a000-0000000270a2';

function row() {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'detail-config-test',
    repoUrl: 'https://github.com/acme/detail-config-test.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: null,
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function configFixture(): ProjectConfigSummary {
  return {
    is_kortix_repo: true,
    signals: { manifest: true },
    manifest_raw: 'name: detail-config-test\nagents:\n  writer:\n    description: Writes.\n',
    manifest: { name: 'detail-config-test' },
    manifest_health: manifestHealthOf('kortix.yaml', []),
    env: { required: [], optional: [] },
    default_agent: 'writer',
    agent_discovery: 'declarative',
    agents: [
      { name: 'writer', path: 'agents/writer.md', description: 'Writes.', mode: null, source: 'kortix.yaml' },
      { name: 'reader', path: 'agents/reader.md', description: 'Reads.', mode: null, source: 'kortix.yaml' },
    ],
    skills: [
      { name: 'plain-skill', path: 'skills/plain-skill/SKILL.md', description: 'Plain.' },
      { name: 'costly-skill', path: 'skills/costly-skill/SKILL.md', description: 'Flagged.' },
    ],
    commands: [{ name: 'cmd-1', path: 'commands/cmd-1', description: 'One command.' }],
  };
}

function filesFixture(): ProjectFileEntry[] {
  return [
    { path: 'kortix.yaml', type: 'file', size: 128 },
    { path: 'agents/writer.md', type: 'file', size: 64 },
    { path: 'agents/reader.md', type: 'file', size: 64 },
    { path: 'skills/plain-skill/SKILL.md', type: 'file', size: 32 },
  ];
}

/** The GitBackedProject the mocked `withProjectGitAuth` answers with (never read). */
const GIT_PROJECT = { projectId: PROJECT_ID, repoUrl: 'git://stub', defaultBranch: 'main', manifestPath: 'kortix.yaml' };

interface SavedSummary {
  sourceCommit: string;
  manifestPath: string;
  config: ProjectConfigSummary;
  files: ProjectFileEntry[];
  fileCount: number;
  filesComplete: boolean;
}

// ─── Per-test state (read through the closures of the mocks below) ──────────
let savedSummary: SavedSummary | null = null;
let gitFiles: ProjectFileEntry[] = [];
let gitListError: Error | null = null; // non-disconnected listing failure → `unavailable`
let gitDisconnected = false; // withProjectGitAuth rejects disconnected → shell still renders
let capMap: Record<string, boolean> = {};
/** The accessible agent/skill names a grant answer may narrow to; null = every id passes. */
let accessibleAgents: string[] | null = null;
let accessibleSkills: string[] | null = null;
let enabledFlags = '';

// The Kortix skills a catalog flag exists behind (the route's flag filter reads
// this one symbol only).
const FLAG_MAP: Record<string, string> = { 'costly-skill': 'costly_skill' };

const realAccess = await import('../lib/access');
const realGitModule = await import('../git');
const realIam = await import('../../iam');
const realIamActor = await import('../../iam/actor');
const realFlagEnv = await import('../lib/feature-flag-env');
const realCatalog = await import('../../skills/catalog');

mock.module('../../shared/db', () => ({
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  hasDatabase: true,
  db: {},
}));

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: row(),
    projectRole: 'manager',
    effectiveRole: 'manager',
  }),
  assertAgentSessionWorkspaceAllowsRepository: async () => {},
  assertProjectCapability: async () => {},
  projectCapabilityAllowed: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => capMap[action] ?? true,
}));

mock.module('../config-summary/service', () => ({
  savedProjectConfig: async () => savedSummary,
}));

mock.module('../lib/git', () => ({
  withProjectGitAuth: async () => {
    if (gitDisconnected) {
      const { RepositoryDisconnectedError } = await import('../../shared/repository-health');
      throw new RepositoryDisconnectedError({ reason: 'app_uninstalled', repository: 'acme/detail-config-test', installationId: null });
    }
    return GIT_PROJECT;
  },
  getProjectGitConnection: async () => null,
}));

mock.module('../git', () => ({
  ...realGitModule,
  listRepoFiles: async () => {
    if (gitListError) throw gitListError;
    return gitFiles;
  },
  loadProjectConfig: async () => configFixture(),
}));

mock.module('../../iam', () => ({
  ...realIam,
  filterAccessibleObjects: async (_actor: unknown, _projectId: string, kind: string, ids: string[]) => {
    const allowed = kind === 'agent' ? accessibleAgents : accessibleSkills;
    return allowed ? ids.filter((id) => allowed.includes(id)) : ids;
  },
  hasAnyResourceGrants: async () => false,
}));

mock.module('../../iam/actor', () => ({
  ...realIamActor,
  actorForToken: async () => ({}),
}));

mock.module('../lib/feature-flag-env', () => ({
  ...realFlagEnv,
  featureFlagsEnvValue: () => enabledFlags,
}));

mock.module('../../skills/catalog', () => ({
  ...realCatalog,
  managedSkillFeatureFlag: (name: string) => FLAG_MAP[name] ?? null,
}));

// Registers project-detail.ts's routes onto the shared `projectsApp` singleton.
// projects.ts (which attaches the `supabaseAuth` middleware) is deliberately
// NOT imported, so this request needs no Authorization header.
const { projectsApp } = await import('../lib/app');
const { registerProjectDetailRoutes } = await import('./project-detail');
registerProjectDetailRoutes();

function getDetail() {
  return projectsApp.request(`/${PROJECT_ID}/detail`, { method: 'GET' });
}

beforeEach(() => {
  const { PROJECT_ACTIONS } = realIam;
  savedSummary = null;
  gitFiles = [];
  gitListError = null;
  gitDisconnected = false;
  capMap = {
    [PROJECT_ACTIONS.PROJECT_FILE_READ]: true,
    [PROJECT_ACTIONS.PROJECT_AGENT_READ]: true,
    [PROJECT_ACTIONS.PROJECT_SKILL_READ]: true,
    [PROJECT_ACTIONS.PROJECT_COMMAND_READ]: true,
  };
  accessibleAgents = null;
  accessibleSkills = null;
  // The route's flag filter runs on every response, so the flagged skill's
  // flag is on in every test's baseline (the flag test turns it off).
  enabledFlags = 'costly_skill';
});

describe('GET /:projectId/detail — characterization of the detail bundle', () => {
  test('snapshot source: the saved summary answers, files from the saved list', async () => {
    savedSummary = {
      sourceCommit: 'cafe1234',
      manifestPath: 'kortix.yaml',
      config: configFixture(),
      files: filesFixture(),
      fileCount: filesFixture().length,
      filesComplete: true,
    };
    const res = await getDetail();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kortix-config-source')).toBe('snapshot; commit=cafe1234');
    expect(res.headers.get('x-kortix-repo-status')).toBeNull();

    const body = (await res.json()) as {
      project: { project_id: string };
      git_connection: null;
      config: Record<string, unknown>;
      file_count: number;
      files: { path: string }[];
    };
    expect(body.project.project_id).toBe(PROJECT_ID);
    expect(body.git_connection).toBeNull();
    expect(body.file_count).toBe(filesFixture().length);
    expect(body.files.map((f) => f.path)).toEqual(filesFixture().map((f) => f.path));
    // The parsed manifest stays on the server: the wire config strips it.
    expect('manifest' in body.config).toBe(false);
    expect(body.config.manifest_raw).toBe(configFixture().manifest_raw);
    expect(body.config.default_agent).toBe('writer');
    expect(body.config.agents).toEqual(configFixture().agents);
    expect(body.config.builtin_agents).toEqual({ my_kortix: false });
    // Both skills stay: the unflagged one always, the flagged one while its
    // flag is on (this run: on).
    expect(body.config.skills).toEqual(configFixture().skills);
    expect(body.config.commands).toEqual(configFixture().commands);
  });

  test('snapshot source past the stored path cap: the file list refreshes from git', async () => {
    savedSummary = {
      sourceCommit: 'cafe1234',
      manifestPath: 'kortix.yaml',
      config: configFixture(),
      files: [],
      fileCount: 0,
      filesComplete: false,
    };
    gitFiles = filesFixture();
    const res = await getDetail();
    expect(res.status).toBe(200);
    // The source header still names the snapshot, and git answers file reads,
    // so the repository is connected rather than disconnected.
    expect(res.headers.get('x-kortix-config-source')).toBe('snapshot; commit=cafe1234');
    expect(res.headers.get('x-kortix-repo-status')).toBeNull();
    const body = (await res.json()) as { file_count: number; files: { path: string }[] };
    expect(body.file_count).toBe(filesFixture().length);
    expect(body.files).toHaveLength(filesFixture().length);
  });

  test('live source: no saved summary loads the config and files from git', async () => {
    gitFiles = filesFixture();
    const res = await getDetail();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kortix-config-source')).toBe('live');
    expect(res.headers.get('x-kortix-repo-status')).toBeNull();

    const body = (await res.json()) as { config: Record<string, unknown>; file_count: number; files: { path: string }[] };
    expect('manifest' in body.config).toBe(false);
    expect(body.config.agents).toEqual(configFixture().agents);
    expect(body.config.manifest_health).toEqual(configFixture().manifest_health);
    expect(body.file_count).toBe(filesFixture().length);
    expect(body.files).toHaveLength(filesFixture().length);
  });

  test('a disconnected repository still renders the shell: no files, disconnected health', async () => {
    gitDisconnected = true;
    const res = await getDetail();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kortix-config-source')).toBe('live');
    expect(res.headers.get('x-kortix-repo-status')).toBe('disconnected');

    const body = (await res.json()) as { config: Record<string, unknown>; file_count: number; files: unknown[] };
    expect('manifest' in body.config).toBe(false);
    expect(body.config.is_kortix_repo).toBe(false);
    expect((body.config.manifest_health as { state: string }).state).toBe('repository_disconnected');
    expect(body.config.agents).toEqual([]);
    expect(body.config.skills).toEqual([]);
    expect(body.config.commands).toEqual([]);
    expect(body.file_count).toBe(0);
    expect(body.files).toEqual([]);
  });

  test('an unavailable repository listing answers with an empty list and marks the header', async () => {
    gitFiles = [];
    gitListError = new Error('listing unavailable in this test');
    const res = await getDetail();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-kortix-config-source')).toBe('live');
    expect(res.headers.get('x-kortix-repo-status')).toBe('unavailable');

    const body = (await res.json()) as { file_count: number; files: unknown[]; config: Record<string, unknown> };
    expect(body.file_count).toBe(0);
    expect(body.files).toEqual([]);
    // The config itself is still served.
    expect(body.config.agents).toEqual(configFixture().agents);
  });

  test('a caller without project.file.read loses the file list but keeps the config sections', async () => {
    gitFiles = filesFixture();
    capMap[realIam.PROJECT_ACTIONS.PROJECT_FILE_READ] = false;
    const res = await getDetail();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: Record<string, unknown>; file_count: number; files: unknown[] };
    expect(body.files).toEqual([]);
    expect(body.file_count).toBe(0);
    expect(body.config.agents).toEqual(configFixture().agents);
    expect(body.config.skills).toEqual(configFixture().skills);
    expect(body.config.commands).toEqual(configFixture().commands);
  });

  test('a caller without project.skill.read gets an empty skills section, agents intact', async () => {
    gitFiles = filesFixture();
    capMap[realIam.PROJECT_ACTIONS.PROJECT_SKILL_READ] = false;
    const res = await getDetail();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: Record<string, unknown> };
    expect(body.config.skills).toEqual([]);
    expect(body.config.agents).toEqual(configFixture().agents);
    expect(body.config.commands).toEqual(configFixture().commands);
  });

  test('a flagged skill is listed only while its feature flag is on', async () => {
    gitFiles = filesFixture();
    enabledFlags = '';    const res = await getDetail();
    const body = (await res.json()) as { config: { skills: unknown[] } };
    expect(body.config.skills).toEqual([
      { name: 'plain-skill', path: 'skills/plain-skill/SKILL.md', description: 'Plain.' },
    ]);

    enabledFlags = 'costly_skill';
    const res2 = await getDetail();
    const body2 = (await res2.json()) as { config: { skills: unknown[] } };
    expect(body2.config.skills).toEqual(configFixture().skills);
  });

  test('a resource grant the member lacks hides that agent from the config AND its file from the list', async () => {
    gitFiles = filesFixture();
    accessibleAgents = ['writer'];
    accessibleSkills = ['plain-skill'];
    // The route's visibility denier filters the RAW file list against the same
    // grant set: another agent's prompt file never reaches the response.
    const res = await getDetail();
    const body = (await res.json()) as {
      config: { agents: { name: string }[]; skills: { name: string }[] };
      files: { path: string }[];
    };
    expect(body.config.agents).toEqual(configFixture().agents.filter((a) => a.name === 'writer'));
    expect(body.config.skills).toEqual(configFixture().skills.filter((s) => s.name === 'plain-skill'));
    expect(body.files.map((f) => f.path)).toEqual(filesFixture().map((f) => f.path).filter((p) => p !== 'agents/reader.md'));
  });
});
