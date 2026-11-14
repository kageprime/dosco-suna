/**
 * The `eval_jobs` and `eval_trials` rows: the index of a job's folder in
 * Files, and the runner's queue state. Every write of a trial names the status
 * it expects, so a cancel and a runner step cannot overwrite each other.
 */
import { evalJobs, evalTrials, sessionSandboxes } from '@kortix/db';
import type { EvalJobConfig, EvalJobStats, EvalJobStatus, EvalTrialStatus, EvalUsage } from '@kortix/api-contract';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { PlannedTrial } from './config';
import { computeJobStats } from './scoring';

export type EvalJobRow = typeof evalJobs.$inferSelect;
export type EvalTrialRow = typeof evalTrials.$inferSelect;

export const ACTIVE_TRIAL_STATUSES: EvalTrialStatus[] = ['starting', 'agent_running', 'verifying'];
export const OPEN_TRIAL_STATUSES: EvalTrialStatus[] = ['queued', ...ACTIVE_TRIAL_STATUSES];

export const jobConfig = (job: EvalJobRow): EvalJobConfig => job.config as unknown as EvalJobConfig;

export async function insertJob(input: {
  projectId: string;
  accountId: string;
  suite: string | null;
  jobName: string;
  commitSha: string;
  ref: string | null;
  config: EvalJobConfig;
  rerunOf: string | null;
  driveId: string;
  folder: string;
  createdBy: string;
  startedBy: StartedBy;
  idempotencyKey: string | null;
  requestHash: string | null;
  trials: PlannedTrial[];
}): Promise<{ job: EvalJobRow | null; existing: EvalJobRow | null }> {
  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      // One request per key at a time: the second waits here, then finds the first's job.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`eval-job:${input.projectId}:${input.idempotencyKey}`}, 0))`);
      const [existing] = await tx
        .select()
        .from(evalJobs)
        .where(and(eq(evalJobs.projectId, input.projectId), eq(evalJobs.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return { job: null, existing };
    }
    const [job] = await tx
      .insert(evalJobs)
      .values({
        projectId: input.projectId,
        accountId: input.accountId,
        suite: input.suite,
        jobName: input.jobName,
        commitSha: input.commitSha,
        ref: input.ref,
        config: input.config as unknown as Record<string, unknown>,
        rerunOf: input.rerunOf,
        driveId: input.driveId,
        folder: input.folder,
        createdBy: input.createdBy,
        startedBy: input.startedBy as unknown as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      })
      .onConflictDoNothing({ target: [evalJobs.projectId, evalJobs.jobName] })
      .returning();
    // A job of this name exists in the project.
    if (!job) return { job: null, existing: null };
    for (let i = 0; i < input.trials.length; i += 500) {
      await tx.insert(evalTrials).values(
        input.trials.slice(i, i + 500).map((trial) => ({
          jobId: job.jobId,
          projectId: input.projectId,
          trialName: trial.trialName,
          taskName: trial.taskName,
          taskRef: trial.taskRef as unknown as Record<string, unknown>,
          agent: trial.agent,
          model: trial.model,
          attempt: trial.attempt,
        })),
      );
    }
    return { job, existing: null };
  });
}

/** The job a POST with this `Idempotency-Key` created, if any. */
export async function jobByIdempotencyKey(projectId: string, key: string): Promise<EvalJobRow | null> {
  const [row] = await db.select().from(evalJobs).where(and(eq(evalJobs.projectId, projectId), eq(evalJobs.idempotencyKey, key))).limit(1);
  return row ?? null;
}

/**
 * Who started a job, as the session create needs it. Trial sessions are
 * created as this principal: a service account stays one, and a token acting
 * from inside a session makes each trial a session that session started.
 */
export interface StartedBy {
  principal_type: 'human' | 'service_account';
  auth_type: string | null;
  api_key_type: string | null;
  in_session: boolean;
  caller_session_id: string | null;
  /**
   * The starter holds `project.sandbox.write`: a task's custom environment may
   * become a new project sandbox template. Without it, a job runs only on
   * templates the project already has.
   */
  may_create_templates?: boolean;
}

export const startedByOf = (job: EvalJobRow): StartedBy | null => (job.startedBy as unknown as StartedBy | null) ?? null;

export async function getJob(projectId: string, jobId: string): Promise<EvalJobRow | null> {
  const [row] = await db.select().from(evalJobs).where(and(eq(evalJobs.projectId, projectId), eq(evalJobs.jobId, jobId))).limit(1);
  return row ?? null;
}

export interface EvalJobFilters {
  status?: EvalJobStatus;
  suite?: string;
  dataset?: string;
  agent?: string;
  model?: string;
  q?: string;
}

const likeEscape = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function jobFilters(projectId: string, filters: EvalJobFilters): SQL | undefined {
  const contains = (path: SQL, value: unknown) => sql`${path} @> ${JSON.stringify([value])}::jsonb`;
  return and(
    eq(evalJobs.projectId, projectId),
    filters.status ? eq(evalJobs.status, filters.status) : undefined,
    filters.suite ? eq(evalJobs.suite, filters.suite) : undefined,
    filters.dataset ? contains(sql`${evalJobs.config}->'datasets'`, { name: filters.dataset }) : undefined,
    filters.agent ? contains(sql`${evalJobs.config}->'agents'`, { name: filters.agent }) : undefined,
    // A model the config names, or the one the trials ran (a default model is recorded from the session).
    filters.model
      ? or(contains(sql`${evalJobs.config}->'agents'`, { model_name: filters.model }), contains(sql`${evalJobs.stats}->'agents'`, { model: filters.model }))
      : undefined,
    filters.q ? ilike(evalJobs.jobName, `%${likeEscape(filters.q)}%`) : undefined,
  );
}

/**
 * Jobs that match, newest first. `after` is the last job of the page before:
 * the page continues strictly below its `(created_at, job_id)`, read from the
 * row itself so no timestamp precision is lost.
 */
export async function listJobs(projectId: string, opts: EvalJobFilters & { limit: number; after?: string }): Promise<EvalJobRow[]> {
  const keyset = opts.after
    ? sql`(${evalJobs.createdAt}, ${evalJobs.jobId}) < (select c.created_at, c.job_id from kortix.eval_jobs c where c.job_id = ${opts.after})`
    : undefined;
  return db
    .select()
    .from(evalJobs)
    .where(and(jobFilters(projectId, opts), keyset))
    .orderBy(desc(evalJobs.createdAt), desc(evalJobs.jobId))
    .limit(opts.limit);
}

export async function countJobs(projectId: string, filters: EvalJobFilters): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(evalJobs).where(jobFilters(projectId, filters));
  return row?.n ?? 0;
}

/** The latest job of each suite of a project. */
export async function latestJobBySuite(projectId: string): Promise<Map<string, EvalJobRow>> {
  const rows = await db
    .selectDistinctOn([evalJobs.suite])
    .from(evalJobs)
    .where(and(eq(evalJobs.projectId, projectId), sql`${evalJobs.suite} is not null`))
    .orderBy(evalJobs.suite, desc(evalJobs.createdAt));
  return new Map(rows.map((row) => [row.suite!, row]));
}

export async function deleteJob(projectId: string, jobId: string): Promise<boolean> {
  const deleted = await db.delete(evalJobs).where(and(eq(evalJobs.projectId, projectId), eq(evalJobs.jobId, jobId))).returning({ jobId: evalJobs.jobId });
  return deleted.length > 0;
}

export async function listTrials(jobId: string): Promise<EvalTrialRow[]> {
  return db.select().from(evalTrials).where(eq(evalTrials.jobId, jobId)).orderBy(asc(evalTrials.taskName), asc(evalTrials.agent), asc(evalTrials.attempt), asc(evalTrials.retry));
}

export async function getTrial(jobId: string, trialId: string): Promise<EvalTrialRow | null> {
  const [row] = await db.select().from(evalTrials).where(and(eq(evalTrials.jobId, jobId), eq(evalTrials.trialId, trialId))).limit(1);
  return row ?? null;
}

/** Jobs the runner still works on, oldest first. */
export async function listOpenJobs(limit: number): Promise<EvalJobRow[]> {
  return db.select().from(evalJobs).where(inArray(evalJobs.status, ['queued', 'running'])).orderBy(asc(evalJobs.createdAt)).limit(limit);
}

export async function listOpenTrials(jobId: string): Promise<EvalTrialRow[]> {
  return db.select().from(evalTrials).where(and(eq(evalTrials.jobId, jobId), inArray(evalTrials.status, OPEN_TRIAL_STATUSES))).orderBy(asc(evalTrials.createdAt), asc(evalTrials.trialName));
}

/**
 * Write a trial only while it still has the status the caller read. False: a
 * cancel (or another runner) moved it first, and the caller drops its step.
 */
export async function updateTrial(trial: Pick<EvalTrialRow, 'trialId' | 'status'>, patch: Partial<typeof evalTrials.$inferInsert>): Promise<boolean> {
  const updated = await db
    .update(evalTrials)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(evalTrials.trialId, trial.trialId), eq(evalTrials.status, trial.status)))
    .returning({ trialId: evalTrials.trialId });
  return updated.length > 0;
}

/** Queue one more run of an attempt (after a retryable error, or on request). Null when that run exists. */
export async function insertRetry(trial: EvalTrialRow, runState: Record<string, unknown> = {}): Promise<EvalTrialRow | null> {
  const retry = trial.retry + 1;
  const [row] = await db
    .insert(evalTrials)
    .values({
      jobId: trial.jobId,
      projectId: trial.projectId,
      trialName: `${trial.trialName.replace(/__r\d+$/, '')}__r${retry}`,
      taskName: trial.taskName,
      taskRef: trial.taskRef,
      agent: trial.agent,
      model: trial.model,
      attempt: trial.attempt,
      retry,
      runState,
    })
    .onConflictDoNothing({ target: [evalTrials.jobId, evalTrials.trialName] })
    .returning();
  return row ?? null;
}

/** The run a trial retry with this idempotency key queued, if any. */
export async function retryByIdempotencyKey(jobId: string, key: string): Promise<EvalTrialRow | null> {
  const [row] = await db
    .select()
    .from(evalTrials)
    .where(and(eq(evalTrials.jobId, jobId), sql`${evalTrials.runState}->>'idempotency_key' = ${key}`))
    .limit(1);
  return row ?? null;
}

/**
 * The last run of each attempt of one task across a project's jobs, newest
 * first. A task is its location (`kind`, `path`, `git_url`), at any commit.
 */
export async function lastRunsOfTask(projectId: string, where: Record<string, unknown>, limit: number): Promise<Array<{ trial: EvalTrialRow; jobName: string }>> {
  const rows = await db
    .selectDistinctOn([evalTrials.jobId, evalTrials.agent, evalTrials.model, evalTrials.attempt], { trial: evalTrials, jobName: evalJobs.jobName })
    .from(evalTrials)
    .innerJoin(evalJobs, eq(evalJobs.jobId, evalTrials.jobId))
    .where(and(eq(evalTrials.projectId, projectId), sql`${evalTrials.taskRef} @> ${JSON.stringify(where)}::jsonb`))
    .orderBy(evalTrials.jobId, evalTrials.agent, evalTrials.model, evalTrials.attempt, desc(evalTrials.retry));
  return rows.sort((a, b) => b.trial.createdAt.getTime() - a.trial.createdAt.getTime()).slice(0, limit);
}

/** Cancel one trial that has not ended. Null when it ended first. */
export async function cancelTrial(trial: EvalTrialRow): Promise<EvalTrialRow | null> {
  const now = new Date();
  const [row] = await db
    .update(evalTrials)
    .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
    .where(and(eq(evalTrials.trialId, trial.trialId), inArray(evalTrials.status, OPEN_TRIAL_STATUSES)))
    .returning();
  return row ?? null;
}

/** Cancel every trial of a job that has not ended. Returns the ones that had a session. */
export async function cancelOpenTrials(jobId: string): Promise<EvalTrialRow[]> {
  const now = new Date();
  return db
    .update(evalTrials)
    .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
    .where(and(eq(evalTrials.jobId, jobId), inArray(evalTrials.status, OPEN_TRIAL_STATUSES)))
    .returning();
}

export async function setJobStatus(jobId: string, from: EvalJobRow['status'][], patch: Partial<typeof evalJobs.$inferInsert>): Promise<boolean> {
  const updated = await db
    .update(evalJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(evalJobs.jobId, jobId), inArray(evalJobs.status, from)))
    .returning({ jobId: evalJobs.jobId });
  return updated.length > 0;
}

/** A trial's stored usage in the wire shape (rows from before `cost_usd` have none). */
export function usageOf(trial: EvalTrialRow): EvalUsage | null {
  const usage = trial.usage as Record<string, number | null> | null;
  if (!usage) return null;
  return {
    n_input_tokens: usage.n_input_tokens ?? 0,
    n_output_tokens: usage.n_output_tokens ?? 0,
    n_cache_tokens: usage.n_cache_tokens ?? 0,
    cost_usd: typeof usage.cost_usd === 'number' ? usage.cost_usd : null,
  };
}

/** Recompute a job's stats from its trials and store them. */
export async function refreshJobStats(job: EvalJobRow): Promise<EvalJobStats> {
  const trials = await listTrials(job.jobId);
  // A run is superseded when a later retry of the same task × agent × model × attempt exists.
  const latest = new Map<string, number>();
  const key = (trial: EvalTrialRow) => `${trial.taskName}\u0000${trial.agent}\u0000${trial.model ?? ''}\u0000${trial.attempt}`;
  for (const trial of trials) latest.set(key(trial), Math.max(latest.get(key(trial)) ?? 0, trial.retry));
  const stats = computeJobStats(
    trials.map((trial) => ({
      taskName: trial.taskName,
      agent: trial.agent,
      model: trial.model,
      source: typeof (trial.taskRef as { source?: unknown }).source === 'string' ? ((trial.taskRef as { source: string }).source) : null,
      attempt: trial.attempt,
      status: trial.status,
      rewards: trial.rewards ?? null,
      rewardValid: trial.rewardValid,
      exceptionType: typeof (trial.exception as { exception_type?: unknown } | null)?.exception_type === 'string' ? (trial.exception as { exception_type: string }).exception_type : null,
      usage: usageOf(trial),
      superseded: trial.retry < (latest.get(key(trial)) ?? 0),
    })),
    jobConfig(job).metrics,
  );
  await db.update(evalJobs).set({ stats: stats as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(evalJobs.jobId, job.jobId));
  return stats;
}

/** Trials that hold a slot, per project, for the per-project cap. */
export async function countActiveTrials(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(evalTrials)
    .where(and(eq(evalTrials.projectId, projectId), or(...ACTIVE_TRIAL_STATUSES.map((status) => eq(evalTrials.status, status)))));
  return row?.n ?? 0;
}

/**
 * Ended trials whose sandbox still runs: a cancel that landed while the runner
 * was creating the session, or a stop that failed. A job that keeps its
 * sandboxes (`environment.delete: false`) keeps those of its graded trials; a
 * cancelled trial's sandbox stops in every job.
 */
export async function endedTrialsWithLiveSandbox(limit: number): Promise<Array<{ job: EvalJobRow; sessionId: string }>> {
  const rows = await db
    .select({ job: evalJobs, sessionId: evalTrials.sessionId })
    .from(evalTrials)
    .innerJoin(evalJobs, eq(evalJobs.jobId, evalTrials.jobId))
    .innerJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, evalTrials.sessionId))
    .where(
      and(
        inArray(evalTrials.status, ['completed', 'errored', 'cancelled']),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
        or(eq(evalTrials.status, 'cancelled'), sql`coalesce(${evalJobs.config}->'environment'->>'delete', 'true') <> 'false'`),
        sql`${evalTrials.finishedAt} > now() - interval '1 day'`,
      ),
    )
    .limit(limit);
  return rows.filter((row): row is { job: EvalJobRow; sessionId: string } => row.sessionId !== null);
}
