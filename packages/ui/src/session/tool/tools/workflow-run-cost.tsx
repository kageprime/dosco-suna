'use client';

import { useEffect, useRef } from 'react';
import { formatUsdAsCredits } from '@kortix/shared';
import type { SessionUsage, SessionUsageTotals } from '@kortix/sdk';
import { useSessionUsage } from '@kortix/sdk/react';
import Hint from '../../../primitives/hint';
import { useTranslations } from '../../../i18n';

/** While the run works, its spend is read again this often. */
const LIVE_REFRESH_MS = 30_000;
/** After the run ends, one more read this much later: billing rows of its last minute land late. */
const SETTLE_REFRESH_MS = 10_000;

/** What Kortix debited for one usage entry: model calls plus compute; a server before compute was added gives model calls only. */
function billed(totals: SessionUsageTotals): number {
  return totals.billed_cost ?? totals.kortix_cost;
}

/**
 * What a workflow run cost so far, in USD, from the session usage tree
 * (`GET …/sessions/:id/usage`): model calls and box time that Kortix billed.
 *
 * - A background run: its runner session and every agent session under it
 *   (`total`), which is the whole run.
 * - A run in the calling session: only its agents' sessions and their
 *   descendants. The caller's own turns are not part of the run.
 *
 * Own-key (BYOK) model spend is not in it: Kortix did not bill it. Exported for tests.
 */
export function runSpentUsd(
  usage: Pick<SessionUsage, 'total' | 'sessions'>,
  agentSessionIds?: readonly string[],
): number {
  if (!agentSessionIds) return billed(usage.total);
  const inRun = new Set(agentSessionIds);
  let sum = 0;
  // `sessions` is depth-first, so a parent is decided before its children.
  for (const entry of usage.sessions) {
    if (!inRun.has(entry.session_id) && !(entry.parent_session_id && inRun.has(entry.parent_session_id))) continue;
    inRun.add(entry.session_id);
    sum += billed(entry);
  }
  return sum;
}

/**
 * "Spent N credits" for a workflow run card: the actual spend, never an
 * estimate. Renders nothing until the read answers, and nothing for a run that
 * has cost nothing yet. Refreshed every 30 s while the run works, and twice as
 * it ends (at once, then 10 s later), so the final number is the final spend.
 * Inline text for the card's status line: `separated` puts a " · " before it.
 */
export function WorkflowRunCost({
  projectId,
  rootSessionId,
  agentSessionIds,
  live,
  separated = false,
}: {
  projectId: string | undefined;
  /** The runner of a background run, else the session that called `workflow`. */
  rootSessionId: string | undefined;
  /** A run in the calling session: its agents' session ids. Omit for a background run. */
  agentSessionIds?: readonly string[];
  live: boolean;
  separated?: boolean;
}) {
  const t = useTranslations('tools.workflow');
  const usage = useSessionUsage(projectId, rootSessionId);
  const { refetch } = usage;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void refetch(), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, refetch]);
  // The run just ended: read the final spend, then once more for rows that land late.
  const wasLive = useRef(live);
  useEffect(() => {
    const ended = wasLive.current && !live;
    wasLive.current = live;
    if (!ended) return;
    void refetch();
    const timer = setTimeout(() => void refetch(), SETTLE_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [live, refetch]);
  if (!usage.data) return null;
  const usd = runSpentUsd(usage.data, agentSessionIds);
  if (!(usd > 0)) return null;
  return (
    <Hint label={t('spentHint')} side="top">
      <span data-testid="workflow-run-cost" className="text-muted-foreground min-w-0 truncate tabular-nums">
        {/* No-break spaces: a flex item drops its edge spaces, which glued "Done·". */}
        {separated && <span aria-hidden>{'\u00a0·\u00a0'}</span>}
        {t('spent', { credits: formatUsdAsCredits(usd) })}
      </span>
    </Hint>
  );
}
