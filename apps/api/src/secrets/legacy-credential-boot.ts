/**
 * The self-host path of the legacy credential migration: the two backfills
 * that an operator runs by script on Kortix cloud
 * (`scripts/llm-credential-backfill.ts`, `scripts/legacy-credential-backfill.ts`)
 * run here on the leader, at boot and then daily
 * (`worker/jobs/legacy-credential-backfill.ts`).
 *
 * Why: a release that stops reading legacy rows (the follow-up to PR #12505)
 * would drop every LLM key a self-host never moved. With this job, the release
 * before it moves them on its first boot, without an operator.
 *
 * Safety: only the lease holder runs jobs (`shared/leader-election.ts`), and
 * each row moves in its own transaction under its row lock, so a second run
 * finds every moved row `unchanged`. Both backfills are idempotent, delete
 * nothing and never log a value.
 *
 * Mode: `LEGACY_CREDENTIAL_BACKFILL_MODE` (config.ts). Default `apply` on
 * self-host and locally, `off` on Kortix cloud.
 */
import { config } from '../config';
import { logger } from '../lib/logger';
import { backfillLegacyCredentials } from './legacy-credential-backfill';
import { backfillLegacyLlmCredentials } from './llm-credential-move';

export interface LegacyCredentialBootSummary {
  mode: 'off' | 'dry_run' | 'apply';
  llm: Record<string, number> | null;
  connector: Record<string, Record<string, number>> | null;
}

export async function runLegacyCredentialBackfills(mode = config.LEGACY_CREDENTIAL_BACKFILL_MODE): Promise<LegacyCredentialBootSummary> {
  if (mode === 'off') return { mode, llm: null, connector: null };
  const apply = mode === 'apply';
  const started = Date.now();
  const llm = await backfillLegacyLlmCredentials({ apply });
  const connector = await backfillLegacyCredentials({ apply });
  // Counts only: the scanned rows, the outcome of each, never a value.
  logger.info('[legacy-credential-backfill] done', {
    mode,
    ms: Date.now() - started,
    llmRows: llm.scanned,
    llmOutcomes: llm.outcomes,
    connectorOutcomes: connector.outcomes,
  });
  return { mode, llm: llm.outcomes, connector: connector.outcomes };
}
