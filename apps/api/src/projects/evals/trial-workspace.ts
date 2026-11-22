/**
 * A fresh workspace per trial (`[metadata.kortix] workspace = "fresh"`).
 *
 * A workspace is one account and its one project, so a trial of its own is an
 * account of its own. The runner makes it before the trial's session, as the
 * person who started the job (its owner), and deletes it after the trial:
 *
 *   1. the `eval_trial_workspaces` row, before anything else: the workspace
 *      switcher hides the account from its first moment, and the sweep finds
 *      a workspace whose trial died half-way;
 *   2. the account, with an id derived from the trial (a retried create
 *      converges), and never the person's one free credit grant;
 *   3. its money: the job's workspace pays. The trial's budget moves from the
 *      job's account to the trial's (two keyed wallet writes), and the trial
 *      account gets the Credits plan when the job's account may use the
 *      Kortix models, so the trial runs the models the job's workspace runs;
 *   4. the project, from the `minimal` starter (My Kortix and `worker`);
 *   5. the job workspace's feature flags plus the task's `requires_flags`;
 *   6. the task's `environment/workspace/` files, committed on top.
 *
 * When the trial ends, its unspent budget goes back at once: a job holds only
 * the budgets of the trials that run. Teardown waits {@link CLEANUP_DELAY_MS}
 * after the trial ended, so the compute and model charges of its last minutes
 * land on the trial account first. Then the Apps it made go (account deletion
 * stops sessions, not App machines), what landed since is squared with the
 * job's account (a refund, or an overspend charged to it), and the account is
 * deleted at once.
 */
import { createHash } from 'node:crypto';
import { apps, appDeployments, appRuntimes, evalTrialWorkspaces } from '@kortix/db';
import { and, eq, isNull, lte, ne, sql } from 'drizzle-orm';
import { createOwnedAccount } from '../../accounts/core/create-account';
import { teardownAppRuntimes } from '../../apps/images';
import { destroyAppVolumes } from '../../apps/volumes';
import { applyAdminOverride } from '../../billing/services/account-write-owner';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { wallet } from '../../billing/wallet';
import { config } from '../../config';
import { isFeatureFlagKey } from '../../feature-flags/registry';
import { writeProjectFeatureFlag } from '../../feature-flags/write';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { accountsView, projectsView } from '../../workspaces/rows';
import { commitMultipleFilesToBranch } from '../git/commit-writer';
import { withProjectGitAuth } from '../lib/git';
import type { ProjectRow } from '../lib/serializers';
import { runProvision } from '../provision-core';
import type { HarborTask } from './harbor-task';
import { EvalTrialError } from './scoring';

/** What a fresh workspace may spend when its task names no `budget_usd`. */
export const DEFAULT_TRIAL_BUDGET_USD = 2;
/** How long after its trial ended a workspace is deleted: late charges land first. */
export const CLEANUP_DELAY_MS = 10 * 60_000;
/** Workspaces one sweep deletes: the next tick takes the rest. */
const SWEEP_BATCH = 5;

/** The runner's progress through {@link prepareTrialWorkspace}, kept in the trial's run state. */
export interface TrialWorkspaceState {
  account_id: string;
  project_id: string;
  funded?: boolean;
  provisioned?: boolean;
  flags_set?: boolean;
  seeded?: boolean;
}

/** A v4-shaped UUID derived from the trial: the same trial always names the same account and project. */
function derivedId(kind: string, trialId: string): string {
  const hex = createHash('sha256').update(`kortix-eval-trial:${kind}:${trialId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function trialWorkspaceIds(trialId: string): { accountId: string; projectId: string } {
  return { accountId: derivedId('account', trialId), projectId: derivedId('project', trialId) };
}

export interface PrepareInput {
  trialId: string;
  jobId: string;
  jobProject: ProjectRow;
  /** The person the trial acts as: the job's creator. */
  ownerUserId: string;
  task: Pick<HarborTask, 'name' | 'kortix'>;
  /** `environment/workspace/`, committed on top of the starter. */
  seed: Array<{ path: string; content: string }>;
}

/**
 * One step towards a ready workspace, repeatable: each call does the next
 * missing part and returns the state to store. `ready` once all parts are done.
 */
export async function prepareTrialWorkspace(input: PrepareInput, state: TrialWorkspaceState | null): Promise<{ state: TrialWorkspaceState; project: ProjectRow | null }> {
  const { accountId, projectId } = trialWorkspaceIds(input.trialId);
  let current: TrialWorkspaceState = state ?? { account_id: accountId, project_id: projectId };
  const budget = input.task.kortix.budgetUsd ?? DEFAULT_TRIAL_BUDGET_USD;
  if (!state) {
    await db
      .insert(evalTrialWorkspaces)
      .values({
        trialAccountId: accountId,
        trialProjectId: projectId,
        trialId: input.trialId,
        jobId: input.jobId,
        payerAccountId: input.jobProject.accountId,
        jobProjectId: input.jobProject.projectId,
        ownerUserId: input.ownerUserId,
        budgetUsd: String(budget),
      })
      .onConflictDoNothing();
    const [account] = await db.select({ accountId: accountsView.accountId }).from(accountsView).where(eq(accountsView.accountId, accountId)).limit(1);
    if (!account) {
      await createOwnedAccount({ userId: input.ownerUserId, name: workspaceName(input.task.name), accountId, freeCredits: false });
    }
    return { state: current, project: null };
  }
  if (!current.funded) {
    await fundTrialWorkspace({ trialId: input.trialId, payerAccountId: input.jobProject.accountId, trialAccountId: accountId, budgetUsd: budget, taskName: input.task.name });
    current = { ...current, funded: true };
    return { state: current, project: null };
  }
  if (!current.provisioned) {
    await provisionTrialProject(input, accountId, projectId);
    current = { ...current, provisioned: true };
    return { state: current, project: null };
  }
  const project = await loadProjectRow(projectId);
  if (!project) throw new EvalTrialError('WorkspaceSetupError', 'The trial workspace was made but its project is gone.');
  if (!current.flags_set) {
    await copyFeatureFlags(input.jobProject, projectId, input.task.kortix.flags);
    current = { ...current, flags_set: true };
  }
  if (!current.seeded) {
    if (input.seed.length > 0) {
      await commitMultipleFilesToBranch(await withProjectGitAuth(project), { files: input.seed, message: 'Eval: the task\'s workspace files' });
    }
    current = { ...current, seeded: true };
  }
  return { state: current, project: (await loadProjectRow(projectId)) ?? project };
}

export const trialWorkspaceReady = (state: TrialWorkspaceState | null | undefined): boolean =>
  Boolean(state?.funded && state.provisioned && state.flags_set && state.seeded);

const workspaceName = (taskName: string): string =>
  `Eval ${taskName.replace(/[^a-zA-Z0-9._ -]+/g, '-')}`.slice(0, 60).trim();

async function loadProjectRow(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return row ?? null;
}

/**
 * The job's workspace pays: the budget leaves its account and lands on the
 * trial's, each write keyed by the trial so a retry moves nothing twice. With
 * billing off (self-host, local) nothing moves and every model is allowed.
 */
async function fundTrialWorkspace(input: { trialId: string; payerAccountId: string; trialAccountId: string; budgetUsd: number; taskName: string }): Promise<void> {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
    await db.update(evalTrialWorkspaces).set({ fundedAt: new Date(), budgetUsd: '0' }).where(eq(evalTrialWorkspaces.trialId, input.trialId));
    return;
  }
  // The trial runs the models its job's workspace runs: the Credits plan, or Free (own keys and free models) like it.
  if (await accountMayUseManagedModels(input.payerAccountId)) {
    await applyAdminOverride(input.trialAccountId, { tier: 'credits' }, { userId: null, action: 'eval.trial_workspace.plan' });
  }
  const description = `Eval trial: ${input.taskName}`.slice(0, 200);
  try {
    await wallet.debit({ accountId: input.payerAccountId, amount: input.budgetUsd, kind: 'usage', description, key: { request: `eval-trial-budget-out:${input.trialId}` } });
  } catch (err) {
    throw new EvalTrialError(
      'BillingBlockedError',
      `A trial in its own workspace takes a budget of $${input.budgetUsd.toFixed(2)} from this workspace's credits, and the credits do not cover it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await wallet.grant({ accountId: input.trialAccountId, amount: input.budgetUsd, kind: 'eval_trial_budget', description, expiring: false, key: { request: `eval-trial-budget-in:${input.trialId}` } });
  await db.update(evalTrialWorkspaces).set({ fundedAt: new Date() }).where(eq(evalTrialWorkspaces.trialId, input.trialId));
}

async function provisionTrialProject(input: PrepareInput, accountId: string, projectId: string): Promise<void> {
  if (await loadProjectRow(projectId)) return;
  const result = await runProvision(
    {
      body: { name: workspaceName(input.task.name), starter_template: 'minimal', idempotency_key: `eval-trial-${input.trialId}` },
      scope: { userId: input.ownerUserId, accountId, accountRole: 'owner' },
      newWorkspace: true,
      projectId,
      evalTrial: true,
    },
    () => {},
  );
  if (result.status >= 300) {
    const body = result.body as { error?: unknown; code?: unknown };
    throw new EvalTrialError('WorkspaceSetupError', `The trial workspace could not be made (${result.status}${body.code ? ` ${String(body.code)}` : ''}): ${String(body.error ?? 'no reason given')}`);
  }
}

/** Every flag the job's workspace set, then the task's own: a trial runs what its job's workspace runs. */
async function copyFeatureFlags(jobProject: ProjectRow, projectId: string, required: string[]): Promise<void> {
  const experimental = ((jobProject.metadata as { experimental?: Record<string, unknown> } | null)?.experimental ?? {}) as Record<string, unknown>;
  const flags = new Map<string, boolean>();
  for (const [key, value] of Object.entries(experimental)) if (typeof value === 'boolean' && isFeatureFlagKey(key)) flags.set(key, value);
  for (const key of required) {
    if (!isFeatureFlagKey(key)) throw new EvalTrialError('TaskUnsupportedError', `The task requires the flag ${key}, which this deployment does not have.`);
    flags.set(key, true);
  }
  for (const [key, value] of flags) await writeProjectFeatureFlag(projectId, key as Parameters<typeof writeProjectFeatureFlag>[1], value);
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * The trial ended and its sandboxes stopped: its unspent budget goes back now,
 * so a job holds only the budgets of the trials that run. The workspace itself
 * is deleted once late charges had time to land.
 */
export async function scheduleTrialWorkspaceCleanup(trialId: string, now: Date): Promise<void> {
  const scheduled = await db
    .update(evalTrialWorkspaces)
    .set({ cleanupAfter: new Date(now.getTime() + CLEANUP_DELAY_MS) })
    .where(and(eq(evalTrialWorkspaces.trialId, trialId), isNull(evalTrialWorkspaces.cleanupAfter)))
    .returning();
  for (const row of scheduled) await settleTrialWorkspace(row, 'release');
}

/**
 * Delete the workspaces whose time came, and schedule those whose trial is
 * gone (a deleted job) or ended without the runner scheduling it.
 */
export async function sweepTrialWorkspaces(now: Date = new Date()): Promise<number> {
  await db.execute(sql`
    UPDATE kortix.eval_trial_workspaces w SET cleanup_after = ${new Date(now.getTime() + CLEANUP_DELAY_MS).toISOString()}::timestamptz
     WHERE w.deleted_at IS NULL AND w.cleanup_after IS NULL
       AND w.created_at < ${new Date(now.getTime() - CLEANUP_DELAY_MS).toISOString()}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM kortix.eval_trials t
          WHERE t.trial_id = w.trial_id AND t.status IN ('queued', 'starting', 'agent_running', 'verifying'))`);
  const due = await db
    .select()
    .from(evalTrialWorkspaces)
    .where(and(isNull(evalTrialWorkspaces.deletedAt), lte(evalTrialWorkspaces.cleanupAfter, now)))
    .limit(SWEEP_BATCH);
  let deleted = 0;
  for (const row of due) {
    try {
      await deleteTrialWorkspace(row);
      deleted += 1;
    } catch (err) {
      logger.warn('[evals] trial workspace not deleted', { trial_id: row.trialId, error: String(err) });
      await db.update(evalTrialWorkspaces).set({ lastError: String(err).slice(0, 500), cleanupAfter: new Date(now.getTime() + CLEANUP_DELAY_MS) }).where(eq(evalTrialWorkspaces.trialAccountId, row.trialAccountId));
    }
  }
  return deleted;
}

async function deleteTrialWorkspace(row: typeof evalTrialWorkspaces.$inferSelect): Promise<void> {
  const [account] = await db.select({ accountId: accountsView.accountId }).from(accountsView).where(eq(accountsView.accountId, row.trialAccountId)).limit(1);
  if (account) {
    await removeWorkspaceApps(row.trialProjectId);
    if (!row.settledAt) await settleTrialWorkspace(row, 'final');
    // Loaded here, not at import: account deletion reaches the sandbox reaper
    // and the legacy runtime bootstrap, which the routes and the proxy must
    // not load at boot (sandbox-proxy/module-graph.test.ts).
    const { deleteAccountImmediately } = await import('../../billing/services/account-deletion');
    await deleteAccountImmediately(row.trialAccountId);
  }
  await db.update(evalTrialWorkspaces).set({ deletedAt: new Date(), lastError: null }).where(eq(evalTrialWorkspaces.trialAccountId, row.trialAccountId));
}

/**
 * The Apps a trial made: account deletion stops its sessions' sandboxes, not
 * App machines. The same teardown as `DELETE /apps/{appId}`, without the
 * kortix.yaml commit (the whole repository goes with the account).
 */
async function removeWorkspaceApps(projectId: string): Promise<void> {
  const live = await db.select({ appId: apps.appId }).from(apps).where(and(eq(apps.projectId, projectId), isNull(apps.deletedAt)));
  for (const { appId } of live) {
    await db.update(apps).set({ deletedAt: new Date(), desiredState: 'stopped', activeDeploymentId: null, updatedAt: new Date() }).where(eq(apps.appId, appId));
    const runtimes = await db
      .select({ runtimeId: appRuntimes.runtimeId, provider: appRuntimes.provider, externalId: appRuntimes.externalId })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
      .where(and(eq(appDeployments.appId, appId), ne(appRuntimes.status, 'deleted')));
    await teardownAppRuntimes(runtimes);
    await destroyAppVolumes(appId);
  }
}

/**
 * Square the trial account with the job's workspace: what it still holds goes
 * back; what it spent past its budget is charged to the job's workspace and
 * the trial account is brought back to zero. Twice: `release` when the trial
 * ends (its budget stops being held), `final` at teardown, for the compute
 * and model charges that landed since. Every move is keyed by the trial and
 * the phase, so a retry moves nothing twice.
 */
async function settleTrialWorkspace(row: typeof evalTrialWorkspaces.$inferSelect, phase: 'release' | 'final'): Promise<void> {
  let left = 0;
  if (config.KORTIX_BILLING_INTERNAL_ENABLED && row.fundedAt) {
    left = Math.round(((await wallet.balance(row.trialAccountId))?.balance ?? 0) * 10_000) / 10_000;
    const key = (what: string) => ({ request: `eval-trial-${phase}-${what}:${row.trialId}` });
    if (left > 0) {
      const description = 'Eval trial: unspent budget';
      await wallet.grant({ accountId: row.trialAccountId, amount: -left, kind: 'eval_trial_refund', description, expiring: false, key: key('refund-out') });
      await wallet.grant({ accountId: row.payerAccountId, amount: left, kind: 'eval_trial_refund', description, expiring: false, key: key('refund-in') });
    } else if (left < 0) {
      const description = 'Eval trial: spent past its budget';
      await wallet.settle({ accountId: row.payerAccountId, amount: -left, kind: 'usage', description, key: key('overspend') });
      await wallet.grant({ accountId: row.trialAccountId, amount: -left, kind: 'eval_trial_refund', description, expiring: false, key: key('overspend-cover') });
    }
  }
  // `refund_usd` is the net that went back to the job's workspace (negative: it paid past the budget).
  await db
    .update(evalTrialWorkspaces)
    .set({ refundUsd: sql`coalesce(${evalTrialWorkspaces.refundUsd}, 0) + ${String(left)}::numeric`, ...(phase === 'final' ? { settledAt: new Date() } : {}) })
    .where(eq(evalTrialWorkspaces.trialAccountId, row.trialAccountId));
}
