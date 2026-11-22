import type { EvalException, EvalJob, EvalJobConfig, EvalJobStats, EvalTrial } from '@kortix/api-contract';
import { logger } from '../../lib/logger';
import { computeJobStats } from './scoring';
import { jobConfig, usageOf, type EvalJobRow, type EvalTrialRow } from './store';
import { trialFolder } from './storage';
import { encodeTaskId } from './task-id';
import { taskRefLabel, type EvalTaskRef } from './task-source';

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** What every read shows in place of a `verifier.env` value. */
export const REDACTED = '<redacted>';

/**
 * A config as readers see it: `verifier.env` keeps its names and loses its
 * values. Anyone who reads a job reads its config, and Files holds a copy, so
 * a value there is never shown back. The runner reads the stored config.
 */
export function redactedConfig(config: EvalJobConfig): EvalJobConfig {
  const env = config.verifier?.env ?? {};
  if (Object.keys(env).length === 0) return config;
  return { ...config, verifier: { ...config.verifier, env: Object.fromEntries(Object.keys(env).map((name) => [name, REDACTED])) } };
}

/** Stats stored before a field existed read with its empty value. */
function statsOf(row: EvalJobRow): EvalJobStats {
  const stats = row.stats as Partial<EvalJobStats>;
  if (typeof stats.n_total_trials !== 'number') return computeJobStats([], []);
  return {
    ...(stats as EvalJobStats),
    n_retries: stats.n_retries ?? 0,
    exception_stats: stats.exception_stats ?? {},
    usage: stats.usage ?? null,
    agents: (stats.agents ?? []).map((agent) => ({ ...agent, source: agent.source ?? null })),
  };
}

export function serializeJob(row: EvalJobRow): EvalJob {
  return {
    job_id: row.jobId,
    project_id: row.projectId,
    suite: row.suite,
    job_name: row.jobName,
    status: row.status,
    commit: row.commitSha,
    ref: row.ref,
    config: redactedConfig(jobConfig(row)),
    stats: statsOf(row),
    rerun_of: row.rerunOf,
    folder: row.folder,
    drive_id: row.driveId,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
  };
}

function trialTaskId(job: Pick<EvalJobRow, 'projectId' | 'commitSha'>, ref: EvalTaskRef): string | null {
  if (ref.kind === 'repo' && !job.commitSha) return null;
  try {
    return encodeTaskId(job.projectId, ref, job.commitSha ?? '');
  } catch (err) {
    logger.warn('[evals] task id not minted', { error: String(err) });
    return null;
  }
}

export function serializeTrial(job: Pick<EvalJobRow, 'folder' | 'projectId' | 'commitSha'>, row: EvalTrialRow): EvalTrial {
  const ref = row.taskRef as unknown as EvalTaskRef;
  return {
    trial_id: row.trialId,
    job_id: row.jobId,
    trial_name: row.trialName,
    task_name: row.taskName,
    task_path: taskRefLabel(ref),
    task_id: trialTaskId(job, ref),
    agent: row.agent,
    model: row.model,
    attempt: row.attempt,
    retry: row.retry,
    status: row.status,
    session_id: row.sessionId,
    rewards: row.rewards ?? null,
    reward_valid: row.rewardValid,
    exception: (row.exception as EvalException | null) ?? null,
    environment_setup: { started_at: iso(row.environmentStartedAt), finished_at: iso(row.environmentFinishedAt) },
    agent_execution: { started_at: iso(row.agentStartedAt), finished_at: iso(row.agentFinishedAt) },
    verifier: { started_at: iso(row.verifierStartedAt), finished_at: iso(row.verifierFinishedAt) },
    usage: usageOf(row),
    folder: trialFolder(job.folder, row.trialName),
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
  };
}
