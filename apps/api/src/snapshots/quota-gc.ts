/**
 * Snapshot quota GC — reclaim superseded snapshots before the org-wide cap bites.
 *
 * Template snapshots are content-addressed (`kortix-default-<hash>` /
 * `kortix-tpl-<hash>`), so every identity drift (each release bumps the runtime
 * fingerprint; every Dockerfile/spec edit) mints a NEW name and silently
 * orphans the old one. Nothing else deletes them: the only same-name deletes
 * run while that exact identity is being rebuilt. Measured live (2026-06-12):
 * ~4.5 new snapshots/day against the 100/org Daytona quota — exhaustion in days,
 * at which point every build org-wide starts failing.
 *
 * This file owns the IO (DB reads, provider deletes). The RULES live in
 * quota-gc-select.ts as a pure function — including the two hard-won invariants:
 * the pressure gate must measure the ORG TOTAL (not just our namespace), and
 * platform defaults must be ranked by freshness (not idle time). See that file's
 * header for why each of those was wrong before, and for the cross-environment
 * safety argument (one Daytona org, many databases).
 *
 * One pass per provider org: Daytona (snapshots, 100/org) and Platinum
 * (templates, `PLATINUM_TEMPLATE_QUOTA`). Platinum ran without a pass until
 * 2026-11-19, when prod held 500/500 templates and every build in the org
 * failed with `org_template_quota_exceeded`. The Platinum list route omits
 * `lastUsedAt`, so the pass reads it per template from the detail route, only
 * under pressure and only for the images the idle rule could reap. Platinum's
 * own `409 template_in_use` keeps any image a sandbox still runs from.
 *
 * Never acts on a partial view: if any provider, reference, or pin read fails,
 * the pass does nothing.
 */

import { appDeployments, appImages, sandboxTemplates } from '@kortix/db';
import { type BudgetReportState, decideBudgetReport } from './budget-report-policy';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import {
  deleteDaytonaSnapshotById,
  isDaytonaConfigured,
  listDaytonaSnapshots,
} from '../shared/daytona';
import { db } from '../shared/db';
import { escalateProviderAuthOutage } from '../shared/provider-auth';
import { projectsView } from '../workspaces/rows';
import { fetchAllTemplates, productionPlatinumClient, type PlatinumClient } from './providers/platinum-templates';
import { templateInUseCount } from './providers/platinum-upload';
import {
  appDeploymentSnapshotName,
  DAYTONA_ORG_BUDGET,
  DEFAULT_PREFIX,
  PPWARM_PREFIX,
  QUOTA_GC_MAX_PER_PASS,
  QUOTA_GC_MIN_IDLE_MS,
  isManaged,
  type OrgImageBudget,
  platinumOrgBudget,
  type SnapshotLike,
  selectSnapshotsToReap,
} from './quota-gc-select';

export type QuotaGcObservationStatus =
  | 'provider_not_configured'
  | 'complete'
  | 'org_list_failed'
  | 'referenced_names_failed';

export interface QuotaGcResult {
  /** Whether every observation needed for safe deletion and admission succeeded. */
  observationStatus: QuotaGcObservationStatus;
  /** Org-wide snapshot count — the number the Daytona quota actually meters. */
  orgTotal: number;
  /** Snapshots in namespaces we own. */
  managedCount: number;
  eligible: number;
  deleted: number;
  /** Reapable but dropped by the per-pass cap. Never silently truncate. */
  deferred: number;
  /** GC cannot get the org back to target — capacity problem, needs a human. */
  budgetUnresolved: boolean;
  dryRun: boolean;
}

export interface SnapshotQuotaIo {
  /** The provider whose org this pass reclaims. Defaults to `daytona`. */
  provider?: 'daytona' | 'platinum';
  /** The org cap. Defaults to Daytona's. */
  budget?: OrgImageBudget;
  isConfigured(): boolean;
  listSnapshots(): Promise<SnapshotLike[]>;
  loadReferencedSnapshotNames(now: number): Promise<Set<string>>;
  deleteSnapshotById(snapshotId: string): Promise<boolean>;
}

/**
 * The name of the App-deployment snapshot a `ready` deployment row still
 * needs. `deployment-worker.ts` builds with the same function, so a live
 * rollback target can never fall out of `referenced` by a naming drift.
 */
export { appDeploymentSnapshotName };

/** Exported for the integration test — hits the real DB, no provider IO. */
export async function loadReferencedSnapshotNames(now: number): Promise<Set<string>> {
  const referenced = new Set(
    (
      await db
        .select({ name: sandboxTemplates.providerSnapshotName })
        .from(sandboxTemplates)
        .where(isNotNull(sandboxTemplates.providerSnapshotName))
    ).map((r) => r.name as string),
  );
  // A deployment is a valid rollback target for as long as (and only as long
  // as) it holds `status = 'ready'` — the rollback route's own gate
  // (`routes.ts`, `POST /apps/{appId}/rollback`). This protects THIS
  // environment's ready deployments outright; it is not itself what makes a
  // `kortix-app-` snapshot reapable. dev/staging/prod share the Daytona org
  // but not a database, so this query is blind to a foreign environment's
  // `ready` row — the actual reap gate is rule 5's idle floor in
  // `quota-gc-select.ts` (see `APP_DEPLOYMENT_PREFIX`'s header for why).
  for (const row of await db
    .select({ deploymentId: appDeployments.deploymentId })
    .from(appDeployments)
    .where(eq(appDeployments.status, 'ready'))) {
    referenced.add(appDeploymentSnapshotName(row.deploymentId));
  }
  // Shared App images: every one this environment tracks. `reclaimAppDeploymentImages`
  // deletes a tracked image once no deployment uses it; GC never races it.
  for (const row of await db.select({ name: appImages.imageName }).from(appImages)) {
    referenced.add(row.name);
  }
  // A template row's last-ready image per provider: the boot fallback while
  // its current image builds or fails (`last-ready-image.ts`).
  for (const row of await db.execute<{ name: string | null }>(sql`
    select distinct v->>'snapshotName' as name
    from kortix.sandbox_templates, jsonb_each(coalesce(metadata->'lastReady', '{}'::jsonb)) as e(k, v)
  `)) {
    if (row.name) referenced.add(row.name);
  }
  // Project routing pins (`ACTIVE_EXTERNAL_ID_META_KEY` and
  // `ACTIVE_SNAPSHOT_NAME_META_KEY` in provider-transition-routing.ts): a
  // provider template id or name a project boots from directly.
  for (const row of await db
    .select({
      id: sql<string | null>`${projectsView.metadata}->>'active_sandbox_external_template_id'`,
      name: sql<string | null>`${projectsView.metadata}->>'active_sandbox_snapshot_name'`,
    })
    .from(projectsView)
    .where(sql`${projectsView.metadata} ?| array['active_sandbox_external_template_id', 'active_sandbox_snapshot_name']`)) {
    if (row.id) referenced.add(row.id);
    if (row.name) referenced.add(row.name);
  }
  return referenced;
}

const defaultSnapshotQuotaIo: SnapshotQuotaIo = {
  provider: 'daytona',
  budget: DAYTONA_ORG_BUDGET,
  isConfigured: isDaytonaConfigured,
  listSnapshots: listDaytonaSnapshots,
  loadReferencedSnapshotNames,
  deleteSnapshotById: deleteDaytonaSnapshotById,
};

/** Parallel template detail reads per batch. */
const PLATINUM_DETAIL_CONCURRENCY = 6;

/**
 * The Platinum org's templates as GC input. Global templates belong to
 * Platinum, not to the org, and do not count against its cap.
 */
export function platinumSnapshotQuotaIo(
  client: PlatinumClient = productionPlatinumClient,
  now: () => number = Date.now,
): SnapshotQuotaIo {
  const budget = platinumOrgBudget(config.PLATINUM_TEMPLATE_QUOTA);
  return {
    provider: 'platinum',
    budget,
    isConfigured: () => client.isConfigured(),
    listSnapshots: async () => {
      const snapshots: SnapshotLike[] = (await fetchAllTemplates(client))
        .filter((template) => template.global !== true && typeof template.name === 'string')
        .map((template) => ({
          id: template.id,
          name: template.name as string,
          state: template.state ?? 'unknown',
          createdAt: template.createdAt ?? null,
          lastUsedAt: null,
        }));
      if (snapshots.length < budget.highWater) return snapshots;
      // The idle rule needs the last use. A template created inside the idle
      // floor cannot have been idle that long, so only older ones are read.
      const idleCandidates = snapshots.filter((snapshot) => {
        if (!isManaged(snapshot.name) || snapshot.name.startsWith(DEFAULT_PREFIX)) return false;
        if (snapshot.name.startsWith(PPWARM_PREFIX)) return false;
        const created = snapshot.createdAt ? Date.parse(snapshot.createdAt) : Number.NaN;
        return Number.isFinite(created) && now() - created > QUOTA_GC_MIN_IDLE_MS;
      });
      for (let i = 0; i < idleCandidates.length; i += PLATINUM_DETAIL_CONCURRENCY) {
        await Promise.all(
          idleCandidates.slice(i, i + PLATINUM_DETAIL_CONCURRENCY).map(async (snapshot) => {
            try {
              const detail = await client.json<{ lastUsedAt?: string | null }>(
                `/v1/templates/${encodeURIComponent(snapshot.id)}`,
              );
              snapshot.lastUsedAt = detail.lastUsedAt ?? null;
            } catch {
              // Unknown last use: count it as used now, so this pass keeps it.
              snapshot.lastUsedAt = new Date(now()).toISOString();
            }
          }),
        );
      }
      return snapshots;
    },
    loadReferencedSnapshotNames,
    deleteSnapshotById: async (templateId) => {
      try {
        await client.json(`/v1/templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/ -> 404(?:\s|$)/.test(message)) return true;
        // A sandbox still runs from it. Platinum keeps it; a later pass retries.
        if (templateInUseCount(message) !== null) return false;
        logger.warn('[snapshot-gc] platinum template delete failed', { templateId, error: message.slice(0, 200) });
        return false;
      }
    },
  };
}

/**
 * One GC pass. Safe to call from the periodic maintenance sweep; all failure
 * modes degrade to "did nothing". Pass `dryRun` to classify without deleting.
 */
/**
 * Process-local memo for the edge-triggered budget alarm. Module scope is what
 * makes the alarm edge-triggered ACROSS passes; tests pass their own through
 * `opts.budgetState` so one case cannot decide the next one's verdict.
 */
// replica-local: one alarm memo per provider org, see the comment above.
const budgetReportStates = new Map<string, BudgetReportState>();

function budgetReportStateFor(provider: string): BudgetReportState {
  let state = budgetReportStates.get(provider);
  if (!state) {
    state = { lastReportedAtMs: null };
    budgetReportStates.set(provider, state);
  }
  return state;
}

export async function reconcileSnapshotQuota(
  opts: { dryRun?: boolean; now?: number; budgetState?: BudgetReportState } = {},
  io: SnapshotQuotaIo = defaultSnapshotQuotaIo,
): Promise<QuotaGcResult> {
  const dryRun = opts.dryRun ?? false;
  const provider = io.provider ?? 'daytona';
  const budget = io.budget ?? DAYTONA_ORG_BUDGET;
  const budgetState = opts.budgetState ?? budgetReportStateFor(provider);
  const result: QuotaGcResult = {
    observationStatus: 'provider_not_configured',
    orgTotal: 0,
    managedCount: 0,
    eligible: 0,
    deleted: 0,
    deferred: 0,
    budgetUnresolved: false,
    dryRun,
  };
  if (!io.isConfigured()) return result;

  result.observationStatus = 'org_list_failed';
  let all: SnapshotLike[];
  try {
    all = await io.listSnapshots();
  } catch (err) {
    // The listing failure (the org's Daytona IO — every call 401s when the
    // org credential is dead) never reaches the maintenance sweep's `.catch`:
    // this pass RESOLVES with the failed status. Escalate here, or a dead
    // key pages nobody from the GC (the G9 probe on PR #12557:
    // `org_list_failed, captured: 0`).
    escalateProviderAuthOutage(provider, 'snapshot quota GC', err);
    console.warn(
      `[snapshot-gc] ${provider} org listing failed — pass skipped:`,
      err instanceof Error ? err.message : err,
    );
    return result;
  }
  const now = opts.now ?? Date.now();

  // Names any local template row would boot from (trust-the-row / graceful
  // last-known-good path). Never delete these.
  result.observationStatus = 'referenced_names_failed';
  let referenced: Set<string>;
  try {
    referenced = await io.loadReferencedSnapshotNames(now);
  } catch (err) {
    console.warn(
      '[snapshot-gc] referenced-name lookup failed — pass skipped:',
      err instanceof Error ? err.message : err,
    );
    // A partial pass still reports the org it inspected (the heartbeat's org/
    // managed counts); the complete pass gets both from the plan instead.
    result.orgTotal = all.length;
    result.managedCount = all.filter((snapshot) => isManaged(snapshot.name)).length;
    return result;
  }

  result.observationStatus = 'complete';

  const plan = selectSnapshotsToReap({ all, referenced, now, budget });
  result.orgTotal = plan.orgTotal;
  result.managedCount = plan.managedCount;
  result.eligible = plan.doomed.length + plan.deferred;
  result.deferred = plan.deferred;
  result.budgetUnresolved = plan.budgetUnresolved;

  // GC has run out of road: one warm tip per active project already exceeds the
  // budget, so no amount of sweeping will keep builds from failing. Only capacity
  // (a bigger org snapshot quota) or gating the warm bake fixes this. Say so —
  // the first outage happened because a GC that couldn't cope logged nothing.
  //
  // Edge-triggered (see budget-report-policy.ts): on arrival, at most hourly
  // while it persists, and once when it clears. Decided BEFORE the pressure
  // early-return below, or the clear edge would be unobservable in the common
  // case where the condition ends by pressure ending.
  if (
    decideBudgetReport({
      unresolved: plan.budgetUnresolved,
      state: budgetState,
      nowMs: now,
    }) === 'report'
  ) {
    if (plan.budgetUnresolved) {
      console.error(
        `[snapshot-gc] BUDGET UNRESOLVED: provider=${provider} org=${plan.orgTotal} target=${budget.target} ` +
          `limit=${budget.limit} — evicted everything eligible and still over. ` +
          `What remains is live, recently used, or outside the Kortix namespaces. Raise the ` +
          `provider quota (PLATINUM_TEMPLATE_QUOTA for Platinum) or delete images Kortix does ` +
          `not manage. At the limit every build in the org fails.`,
      );
    } else {
      console.log(
        `[snapshot-gc] budget resolved: provider=${provider} org=${plan.orgTotal} target=${budget.target} ` +
          `limit=${budget.limit} — back inside the snapshot budget.`,
      );
    }
    budgetState.lastReportedAtMs = plan.budgetUnresolved ? now : null;
  }

  if (!plan.underPressure) return result;

  for (const { snapshot, reason } of plan.doomed) {
    if (dryRun) {
      console.log(`[snapshot-gc] DRY RUN would delete ${provider} ${snapshot.name} (${reason})`);
      result.deleted++;
      continue;
    }
    const ok = await io.deleteSnapshotById(snapshot.id);
    console.log(`[snapshot-gc] delete ${provider} ${snapshot.name} (${reason}): ${ok ? 'ok' : 'kept'}`);
    if (ok) result.deleted++;
  }

  console.log(
    `[snapshot-gc] ${provider} org=${result.orgTotal} managed=${result.managedCount} ` +
      `eligible=${result.eligible} ${dryRun ? 'would-delete' : 'deleted'}=${result.deleted}` +
      (result.deferred > 0
        ? ` deferred=${result.deferred} (cap ${QUOTA_GC_MAX_PER_PASS}/pass)`
        : ''),
  );
  return result;
}

/** One GC pass over the Platinum org's templates. */
export function reconcilePlatinumTemplateQuota(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<QuotaGcResult> {
  return reconcileSnapshotQuota(opts, platinumSnapshotQuotaIo());
}
