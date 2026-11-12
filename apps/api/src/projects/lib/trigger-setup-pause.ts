/**
 * A trigger the account cannot run pauses at once and resumes by itself.
 *
 * Prod audit, 2026-11-11, two classes:
 * - no usable model (36 accounts, most on the Free plan): triggers saved
 *   fine, and every fire dead-lettered "No usable model". 19 accounts were
 *   auto-paused only after 24 hours of failures (trigger-failure-pause.ts).
 * - an empty wallet (21 accounts): cron triggers kept firing, ~6.9k fires and
 *   ~6.8k refused session creates in 14 days, each one a dead letter.
 *
 * Both refusals describe the account, not the trigger, and a person fixes
 * them somewhere else: a model key, a plan, a top-up. So:
 * - a save that leaves a trigger on (the API route, the CLI through it, a
 *   kortix.yaml sync) runs the fire's model check (`triggerModelRefusal`).
 *   A refusal pauses the trigger with the reason, so the Triggers page shows
 *   the cause before the first fire. A save of an off trigger checks nothing,
 *   and no save is ever refused;
 * - the first fire the model check or the billing gate refuses pauses the
 *   trigger the same way. Its dead letter already tells the watchers the
 *   cause (trigger-alerts.ts, one alert per failure streak), so the pause
 *   sends none of its own: an empty wallet pauses every trigger of the
 *   account at once, and a second alert per trigger would repeat the first;
 * - the scheduler checks every such pause each 2 minutes and resumes the
 *   trigger when the cause is gone: the wallet pays for a run again, or the
 *   workspace has a model an automation can use. A cron slot missed while
 *   paused fires once on resume, as after any pause.
 *
 * The pause is the KRTX-1721 one (`project_trigger_runtime.auto_paused_at`),
 * so every automatic source skips it and a person's Resume (`PATCH enabled:
 * true`) ends it. The reason's prefix names the cause; `setupPauseCode` reads
 * it back. A manual fire is never held: a person who fires it sees the 402.
 */
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq, isNotNull, like, or } from 'drizzle-orm';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { errorMessage } from '../../shared/error-message';
import { projectsView } from '../../workspaces/rows';
import { resolveProjectAutomationActor } from '../session-lifecycle/actor';
import type { GitTriggerSpec } from '../triggers';
import { triggerTargetOf } from './runtime-triggers';
import { triggerModelRefusal } from './trigger-model-gate';
import { autoPauseTrigger } from './trigger-run-caps';

/** A pause that ends by itself: `billing` when a run can be paid for, `no_usable_model` when a model is usable. */
export type SetupPauseCode = 'billing' | 'no_usable_model';

const PREFIX: Record<SetupPauseCode, string> = {
  billing: 'auto-paused: billing: ',
  no_usable_model: 'auto-paused: no usable model: ',
};

/** The reason a pause for `code` carries: the prefix, then the refusal the account got. */
export function setupPauseReason(code: SetupPauseCode, message: string): string {
  return `${PREFIX[code]}${message.split('\n')[0]!.trim().slice(0, 300)}`;
}

/** The cause of a pause that ends by itself, read from its reason; null for any other pause. */
export function setupPauseCode(reason: string | null | undefined): SetupPauseCode | null {
  if (!reason) return null;
  if (reason.startsWith(PREFIX.billing)) return 'billing';
  if (reason.startsWith(PREFIX.no_usable_model)) return 'no_usable_model';
  return null;
}

/** The pause a refused fire's `errorCode` calls for, or null. */
export function setupPauseCodeForFire(errorCode: string | null | undefined): SetupPauseCode | null {
  if (errorCode === 'insufficient_credits' || errorCode === 'subscription_required') return 'billing';
  if (errorCode === 'no_usable_model') return 'no_usable_model';
  return null;
}

/**
 * After a refused fire: pause the trigger when the refusal is account state.
 * True only for the call that paused it. Never throws.
 */
export async function pauseTriggerOnAccountRefusal(input: {
  projectId: string;
  accountId: string;
  slug: string;
  errorCode?: string | null;
  error?: string | null;
  now?: Date;
}): Promise<boolean> {
  const code = setupPauseCodeForFire(input.errorCode);
  if (!code) return false;
  const now = input.now ?? new Date();
  const reason = setupPauseReason(code, input.error || input.errorCode!);
  try {
    if (!(await autoPauseTrigger(input.projectId, input.slug, reason, now))) return false;
    logger.warn('[trigger-setup-pause] trigger paused: the account cannot run it', {
      project_id: input.projectId,
      slug: input.slug,
      code,
    });
    return true;
  } catch (err) {
    logger.warn('[trigger-setup-pause] pause failed', { project_id: input.projectId, slug: input.slug, error: errorMessage(err) });
    return false;
  }
}

/** A trigger that starts an agent session: the ones the model check applies to. */
function startsSession(spec: GitTriggerSpec): boolean {
  return spec.enabled !== false && !spec.reminder && triggerTargetOf(spec).kind === 'agent';
}

/**
 * After a save: the fire's model check for the triggers that are on. A
 * refusal pauses each of them that is not paused already (no alert: the
 * person who saved sees it); no refusal resumes the project's model pauses.
 * `specs` are the triggers the save wrote (the runtime rows exist). Returns
 * the refusal, or null. Never throws, never refuses the save.
 */
export async function gateTriggerSetup(input: {
  projectId: string;
  accountId: string;
  specs: readonly GitTriggerSpec[];
  now?: Date;
}): Promise<string | null> {
  const on = input.specs.filter(startsSession);
  if (on.length === 0) return null;
  const now = input.now ?? new Date();
  try {
    const actor = await resolveProjectAutomationActor(input.accountId);
    if (!actor) return null;
    const refusal = await triggerModelRefusal({ projectId: input.projectId, accountId: input.accountId, actor });
    if (!refusal) {
      await resumeSetupPauses({ projectId: input.projectId, now });
      return null;
    }
    const reason = setupPauseReason('no_usable_model', refusal);
    for (const spec of on) await autoPauseTrigger(input.projectId, spec.slug, reason, now);
    return refusal;
  } catch (err) {
    logger.warn('[trigger-setup-pause] save check failed', { project_id: input.projectId, error: errorMessage(err) });
    return null;
  }
}

const RESUME_EVERY_MS = 2 * 60_000;
/** Paused triggers read per pass. */
const RESUME_LIMIT = 500;
// replica-local: only the scheduler leader runs the pass. A new leader runs
// it at once, which resumes nothing twice: the pause is in the database.
let lastResumeAt = 0;

/**
 * Resume every pause that ends by itself whose cause is gone: the account's
 * billing gate admits a run, or the project's model check passes. One check
 * per account and per project. Scoped to one project when `projectId` is
 * given. Returns the triggers resumed.
 */
export async function resumeSetupPauses(input: { projectId?: string; now?: Date } = {}): Promise<number> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      projectId: projectTriggerRuntime.projectId,
      slug: projectTriggerRuntime.slug,
      reason: projectTriggerRuntime.autoPausedReason,
      accountId: projectsView.accountId,
    })
    .from(projectTriggerRuntime)
    .innerJoin(projectsView, eq(projectsView.projectId, projectTriggerRuntime.projectId))
    .where(
      and(
        isNotNull(projectTriggerRuntime.autoPausedAt),
        or(like(projectTriggerRuntime.autoPausedReason, `${PREFIX.billing}%`), like(projectTriggerRuntime.autoPausedReason, `${PREFIX.no_usable_model}%`)),
        input.projectId ? eq(projectTriggerRuntime.projectId, input.projectId) : undefined,
      ),
    )
    .limit(RESUME_LIMIT);

  const billing = new Map<string, Promise<boolean>>();
  const models = new Map<string, Promise<boolean>>();
  const billingOk = (accountId: string) => {
    if (!billing.has(accountId)) billing.set(accountId, checkBillingAdmission(accountId).then((r) => r.ok));
    return billing.get(accountId)!;
  };
  const modelOk = (accountId: string, projectId: string) => {
    if (!models.has(projectId)) {
      models.set(
        projectId,
        resolveProjectAutomationActor(accountId).then(async (actor) =>
          actor ? (await triggerModelRefusal({ projectId, accountId, actor })) === null : false,
        ),
      );
    }
    return models.get(projectId)!;
  };

  let resumed = 0;
  for (const row of rows) {
    const code = setupPauseCode(row.reason);
    if (!code || !row.accountId) continue;
    try {
      const healed = code === 'billing' ? await billingOk(row.accountId) : await modelOk(row.accountId, row.projectId);
      if (!healed) continue;
      // Only the pause that was read: a pause for another cause since stays.
      const cleared = await db
        .update(projectTriggerRuntime)
        .set({ autoPausedAt: null, autoPausedReason: null, autoPauseResumedAt: now, updatedAt: now })
        .where(
          and(
            eq(projectTriggerRuntime.projectId, row.projectId),
            eq(projectTriggerRuntime.slug, row.slug),
            eq(projectTriggerRuntime.autoPausedReason, row.reason!),
          ),
        )
        .returning({ slug: projectTriggerRuntime.slug });
      if (cleared.length === 0) continue;
      resumed += 1;
      logger.info('[trigger-setup-pause] trigger resumed: the cause is gone', { project_id: row.projectId, slug: row.slug, code });
    } catch (err) {
      logger.warn('[trigger-setup-pause] resume check failed', { project_id: row.projectId, slug: row.slug, error: errorMessage(err) });
    }
  }
  return resumed;
}

/** The scheduler's pass: at most once each 2 minutes. Null when it ran more recently. */
export async function resumeSetupPausesTick(now = new Date(), force = false): Promise<number | null> {
  if (!force && now.getTime() - lastResumeAt < RESUME_EVERY_MS) return null;
  lastResumeAt = now.getTime();
  return resumeSetupPauses({ now });
}
