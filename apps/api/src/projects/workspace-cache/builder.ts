/**
 * The workspace cache's daily rebuild (flag `platinum_cache`).
 *
 * A project's cache is only as fresh as its newest saved workspace. A person
 * saves the first one (POST /v1/projects/:id/workspace-cache), which records
 * the agent whose box built it and the person who saved it. From then on this
 * job rebuilds it once a day, the same way: a session of that agent, as that
 * person, with no model turn; the project's own `scripts/workspace-cache-build`
 * (from the session's served config) run in its box as the runtime user, detached
 * with the eval runner's launch/poll (a plain `nohup … &` dies with the exec call
 * that started it); and,
 * when it prints `workspace-cache-key: ws-…` and exits 0, a save of that
 * session's /workspace under that key. The save is the API's own, so a session
 * never decides what later sessions start from.
 *
 * One build per project at a time; a build that has not finished in
 * BUILD_TIMEOUT_MS is stopped and recorded as failed, and the next one waits a
 * full REBUILD_AFTER_MS. Measured on CompanyOS (2026-11-26): a 14-day-old
 * workspace still installs in 8.3 s against 2.3 s fresh, so a day is plenty.
 */
import { projectSessions } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';

import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import {
  isWorkspaceCacheKey,
  listWorkspaceCache,
  recordedWorkspaceVolume,
  saveWorkspaceCache,
  WORKSPACE_CACHE_PNPM_STORE,
} from '../../platform/services/workspace-volume';
import { resolveSessionPlacement } from '../../platform/services/sandbox-region';
import { db } from '../../shared/db';
import { metadataMergeSubtree, projectsView, updateProjectRowsReturning } from '../../workspaces/rows';
import { boxReady, launch, poll, readTextFile, sessionBox } from '../evals/box';
import { createSession } from '../session-lifecycle';
import { abortRuntimeTurn } from '../session-lifecycle/abort-runtime-turn';
import { stopSession } from '../session-lifecycle/stop';

export const WORKSPACE_CACHE_BUILD_SOURCE = 'system:workspace-cache' as const;
/** projects.metadata key: who builds the project's workspace cache. */
export const WORKSPACE_CACHE_PROJECT_KEY = 'workspace_cache';
/** project_sessions.metadata key on a build session: its progress. */
export const WORKSPACE_CACHE_BUILD_KEY = 'workspace_cache_build';
export const REBUILD_AFTER_MS = 24 * 3600_000;
export const BUILD_TIMEOUT_MS = 45 * 60_000;
const BUILDER = 'scripts/workspace-cache-build';
/** The build's output, outside /tmp (tmpfs on Platinum). */
const BUILD_OUTPUT = '/var/tmp/kortix-workspace-cache/build.out';
/** The detached run's id for launch/poll: one per build session. */
const buildRunId = (sessionId: string): string => `workspace-cache-${sessionId}`;
/** The box's runtime user: the builder's files must be the sessions' own. */
const RUNTIME_USER = 'kortix';

export interface WorkspaceCacheBuilder {
  agent: string;
  user_id: string;
  /** ISO time of the save that named them. */
  named_at: string;
}

type BuildState = 'starting' | 'running' | 'saved' | 'failed';
interface BuildRecord {
  state: BuildState;
  started_at: string;
  key?: string;
  error?: string;
}

/** A project's recorded builder, when its metadata names a valid one. */
export function workspaceCacheBuilderOf(projectMetadata: unknown): WorkspaceCacheBuilder | null {
  const raw = (projectMetadata as Record<string, unknown> | null | undefined)?.[WORKSPACE_CACHE_PROJECT_KEY] as
    | Partial<WorkspaceCacheBuilder>
    | undefined;
  if (!raw || typeof raw.agent !== 'string' || !raw.agent || typeof raw.user_id !== 'string' || !raw.user_id) return null;
  return { agent: raw.agent, user_id: raw.user_id, named_at: typeof raw.named_at === 'string' ? raw.named_at : '' };
}

/** A person's save names the agent and person every later rebuild uses. */
export async function recordWorkspaceCacheBuilder(projectId: string, builder: WorkspaceCacheBuilder): Promise<void> {
  await updateProjectRowsReturning(eq(projectsView.projectId, projectId), {
    metadata: metadataMergeSubtree(WORKSPACE_CACHE_PROJECT_KEY, { ...builder }),
    updatedAt: sql`date_trunc('milliseconds', now())`,
  });
}

/**
 * What a build runs in the box, as root, detached by `launch`: the project's own builder from the newest
 * served config, as the runtime user, with the cache's env. Exit 127 when the project ships no builder.
 */
export function builderRunCommand(namespace: string): string {
  return [
    // runuser lives in /usr/sbin, which the exec channel's PATH need not carry.
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'cfg="$(ls -dt /opt/kortix/config/*/ 2>/dev/null | head -1)"',
    `b="\${cfg}${BUILDER}"`,
    `if [ -z "$cfg" ] || [ ! -x "$b" ]; then echo "no ${BUILDER} in the served config"; exit 127; fi`,
    `exec runuser -u ${RUNTIME_USER} -- env HOME=/home/${RUNTIME_USER} KORTIX_WORKSPACE_CACHE=${shellQuote(namespace)} ` +
      `npm_config_store_dir=${WORKSPACE_CACHE_PNPM_STORE} PATH=/usr/local/bin:/opt/supabase:/usr/bin:/bin "$b"`,
  ].join('\n');
}

/** The key the builder printed last, when its output ends with a valid one. */
export function keyFromBuilderOutput(out: string): string | null {
  const lines = out.trim().split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  const m = /^workspace-cache-key: (\S+)$/.exec(last);
  return m && isWorkspaceCacheKey(m[1]) ? m[1] : null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildOf(metadata: unknown): BuildRecord | null {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[WORKSPACE_CACHE_BUILD_KEY] as BuildRecord | undefined;
  return raw && typeof raw.state === 'string' && typeof raw.started_at === 'string' ? raw : null;
}

async function writeBuild(sessionId: string, record: BuildRecord): Promise<void> {
  await db
    .update(projectSessions)
    .set({ metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [WORKSPACE_CACHE_BUILD_KEY]: record })}::jsonb` })
    .where(eq(projectSessions.sessionId, sessionId));
}

async function stopBuildSession(projectId: string, accountId: string, sessionId: string, userId: string): Promise<void> {
  await abortRuntimeTurn(sessionId, { requestedStop: true, stoppedBy: null }).catch(() => false);
  await stopSession({ projectId, sessionId, accountId, userId, stoppedBy: null }).catch((err) =>
    logger.warn('[workspace-cache] build session not stopped', { sessionId, error: String(err) }),
  );
}

type ProjectRow = typeof projectsView.$inferSelect;

/** The project's newest build session, if any. */
async function latestBuild(projectId: string) {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId, metadata: projectSessions.metadata, createdAt: projectSessions.createdAt, accountId: projectSessions.accountId })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), sql`${projectSessions.metadata} ? ${WORKSPACE_CACHE_BUILD_KEY}::text`))
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Advance one project's build by one step. Returns true when it did something or a build is in flight,
 * so the job keeps looking every minute until the build ends.
 */
export async function advanceWorkspaceCacheBuild(project: ProjectRow, now: Date): Promise<boolean> {
  const builder = workspaceCacheBuilderOf(project.metadata);
  if (!builder || !resolveFeatureFlag(project.metadata, 'platinum_cache')) return false;
  const latest = await latestBuild(project.projectId);
  const record = latest ? buildOf(latest.metadata) : null;
  if (latest && record && (record.state === 'starting' || record.state === 'running')) {
    return advanceRunning(project, builder, latest.sessionId, latest.metadata, record, now);
  }
  if (latest && now.getTime() - latest.createdAt.getTime() < REBUILD_AFTER_MS) return false;
  // A person's save in the last day counts as today's build.
  // The project's session region: its cache entries live there.
  const placement = await resolveSessionPlacement(project.projectId, project.metadata);
  const listed = await listWorkspaceCache(project.projectId, placement.location ?? null).catch(() => null);
  const newest = listed?.entries.map((e) => (e.created_at ? Date.parse(e.created_at) : 0)).sort((a, b) => b - a)[0] ?? 0;
  if (newest && now.getTime() - newest < REBUILD_AFTER_MS - 3600_000) return false;
  return (await startBuild(project, builder, now)) !== null;
}

/**
 * Start a build now (POST …/workspace-cache/build): the project's recorded builder, unless one is
 * already running. The caller checked the flag and the person's rights.
 */
export async function startWorkspaceCacheBuildNow(
  project: ProjectRow,
  now: Date = new Date(),
): Promise<{ session_id: string } | { error: 'no_builder' | 'build_running' | 'not_started' }> {
  const builder = workspaceCacheBuilderOf(project.metadata);
  if (!builder) return { error: 'no_builder' };
  const latest = await latestBuild(project.projectId);
  const record = latest ? buildOf(latest.metadata) : null;
  if (latest && record && (record.state === 'starting' || record.state === 'running') && now.getTime() - Date.parse(record.started_at) <= BUILD_TIMEOUT_MS) {
    return { error: 'build_running' };
  }
  const sessionId = await startBuild(project, builder, now);
  return sessionId ? { session_id: sessionId } : { error: 'not_started' };
}

async function startBuild(project: ProjectRow, builder: WorkspaceCacheBuilder, now: Date): Promise<string | null> {
  const sessionId = crypto.randomUUID();
  const result = await createSession({
    source: WORKSPACE_CACHE_BUILD_SOURCE,
    project,
    userId: builder.user_id,
    requestingPrincipalType: 'human',
    callerSessionId: null,
    body: { session_id: sessionId, name: 'Workspace cache build', agent_name: builder.agent },
    metadata: { [WORKSPACE_CACHE_BUILD_KEY]: { state: 'starting', started_at: now.toISOString() } satisfies BuildRecord },
  });
  if (result.error) {
    logger.warn('[workspace-cache] build session not created', {
      projectId: project.projectId,
      status: result.error.status,
      error: String(result.error.body?.error ?? result.error.body?.message ?? ''),
    });
    return null;
  }
  logger.info('[workspace-cache] build started', { projectId: project.projectId, sessionId, agent: builder.agent });
  return sessionId;
}

async function advanceRunning(
  project: ProjectRow,
  builder: WorkspaceCacheBuilder,
  sessionId: string,
  sessionMetadata: unknown,
  record: BuildRecord,
  now: Date,
): Promise<boolean> {
  const fail = async (error: string) => {
    await writeBuild(sessionId, { ...record, state: 'failed', error: error.slice(0, 500) });
    await stopBuildSession(project.projectId, project.accountId, sessionId, builder.user_id);
    logger.warn('[workspace-cache] build failed', { projectId: project.projectId, sessionId, error: error.slice(0, 300) });
    return true;
  };
  if (now.getTime() - Date.parse(record.started_at) > BUILD_TIMEOUT_MS) return fail(`not finished in ${BUILD_TIMEOUT_MS / 60_000} min`);
  const volume = recordedWorkspaceVolume(sessionId, sessionMetadata);
  if (!volume?.cache) return fail('the build session has no workspace cache (flag turned off, or no volume)');
  const found = await sessionBox(sessionId);
  // Still booting: in flight, look again next minute.
  if (!found?.box || !(await boxReady(found.box))) return true;
  const box = found.box;
  const runId = buildRunId(sessionId);
  if (record.state === 'starting') {
    try {
      await launch(box, runId, {
        command: builderRunCommand(volume.cache.namespace),
        cwd: '/workspace',
        env: {},
        timeoutSec: Math.floor(BUILD_TIMEOUT_MS / 1000),
        outputPath: BUILD_OUTPUT,
      });
    } catch (err) {
      return fail(`builder did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    await writeBuild(sessionId, { ...record, state: 'running' });
    return true;
  }
  const run = await poll(box, runId);
  if (run.state === 'running') return true;
  if (run.state === 'missing') return fail('the build is not on the box: it never started, or the box was replaced');
  const out = (await readTextFile(box, BUILD_OUTPUT, 6000).catch(() => null)) ?? '';
  if (run.exitCode !== 0) return fail(`builder exited ${run.exitCode}: ${out.trim().split('\n').slice(-3).join(' | ')}`);
  const key = keyFromBuilderOutput(out);
  if (!key) return fail('builder printed no workspace-cache-key line');
  try {
    await saveWorkspaceCache({ projectId: project.projectId, sessionId, sessionMetadata, key });
  } catch (err) {
    return fail(`save: ${err instanceof Error ? err.message : String(err)}`);
  }
  await writeBuild(sessionId, { ...record, state: 'saved', key });
  await stopBuildSession(project.projectId, project.accountId, sessionId, builder.user_id);
  logger.info('[workspace-cache] build saved', { projectId: project.projectId, sessionId, key });
  return true;
}

/** One pass over every project with the flag on and a recorded builder. Returns how many advanced. */
export async function runWorkspaceCacheBuilderTick(now: Date = new Date()): Promise<number> {
  const projects = await db
    .select()
    .from(projectsView)
    .where(sql`${projectsView.metadata} -> 'experimental' ->> 'platinum_cache' = 'true' and ${projectsView.metadata} ? ${WORKSPACE_CACHE_PROJECT_KEY}::text`);
  let advanced = 0;
  for (const project of projects) {
    try {
      if (await advanceWorkspaceCacheBuild(project, now)) advanced++;
    } catch (err) {
      logger.warn('[workspace-cache] build step failed', { projectId: project.projectId, error: String(err) });
    }
  }
  return advanced;
}
