'use client';

import {
  approvalReviewable,
  type ApprovalDecisionValue,
  type ApprovalResolvers,
  useApprovalWaitingText,
} from '../../session/prompts/approval-request';
import { ApprovalDecisionPanel } from '../../markdown/setup-links/approval-decision';
import { useTranslations } from '../../i18n';
import type { ApprovalLinkDetails } from '@kortix/sdk';
import { useId } from 'react';

import { connectorCallId } from './review-actions';
import type { ReviewItem } from './types';

/**
 * A Connector approval as the standalone approve page reads it, built from the
 * Review Center row the inbox already holds — no second request. Null for any
 * item that is not one adapted Connector call.
 */
export function reviewApprovalDetails(item: ReviewItem): ApprovalLinkDetails | null {
  const executionId = connectorCallId(item.id);
  const call = item.kind === 'approval' ? item.detail.actions?.[0] : undefined;
  if (!executionId || !call) return null;
  // `waiting`: still pending, on someone else's decision (KRTX-1724).
  const pending = item.status === 'needs_you' || item.status === 'waiting';
  return {
    kind: 'approval',
    project_id: '',
    project_name: item.project,
    execution_id: executionId,
    session_id: item.sessionId ?? null,
    action: call.actionPath || call.title,
    connector: call.connector || null,
    connector_name: call.connectorName ?? null,
    risk: call.connectorRisk ?? null,
    status:
      item.status === 'approved'
        ? 'ok'
        : item.status === 'rejected'
          ? 'denied'
          : item.status === 'expired'
            ? 'expired'
            : 'pending_approval',
    pending,
    args_preview: call.rawArgsPreview ?? null,
    review_complete: call.reviewComplete === true,
    args_summary: null,
    approval_context: call.approvalContext ?? null,
    resolved_preview: call.resolvedPreview ?? null,
    resolved_error: call.resolvedError ?? null,
    policy_source: call.policySource,
    requested_at: item.createdAt,
    resolved_at: null,
    expires_at: item.expiresAt ?? '',
  };
}

/**
 * A pending connector call that shows nothing to review: the decision panel
 * offers only Deny. The same rule the panel applies (`approvalReviewable`) on
 * the same details, so the list row and the modal never disagree.
 */
export function reviewApprovalDenyOnly(item: ReviewItem): boolean {
  const details = reviewApprovalDetails(item);
  if (!details || !details.pending) return false;
  return !approvalReviewable(details.args_preview, details.review_complete, details.resolved_preview);
}

/**
 * Who asked for the call, as the decision panel names them. The SDK labels a
 * row with no agent "Agent", and an approval's summary is its session's title
 * only when that title is known; anything else names nobody.
 */
export function reviewApprovalAsker(
  item: ReviewItem,
  sessionLabels: Record<string, string> = {},
): { agentName: string | null; sessionTitle: string | null } {
  const agent = item.agent && item.agent !== 'Agent' ? item.agent : null;
  return {
    agentName: agent,
    sessionTitle: item.sessionId ? (sessionLabels[item.sessionId] ?? null) : null,
  };
}

/**
 * The standalone approve page (`/approve/[token]`), inline in the inbox's
 * detail pane. One approval UI everywhere: the same panel in the same bordered
 * card, the same rows, the same decision. No `onDecision` = the viewer may read
 * the call but not decide it.
 */
export function ApprovalDecisionPane({
  details,
  previewAuthorized,
  busyDecision,
  onDecision,
  onOpenSession,
  resolvers = null,
  agentName = null,
  sessionTitle = null,
}: {
  details: ApprovalLinkDetails;
  previewAuthorized?: boolean;
  /** Who decides the call, for a viewer who may not (KRTX-1724). */
  resolvers?: ApprovalResolvers | null;
  busyDecision: ApprovalDecisionValue | null;
  onDecision?: (decision: ApprovalDecisionValue, note?: string) => void;
  onOpenSession?: () => void;
  /** The agent that asked. Null: "An agent". */
  agentName?: string | null;
  /** The session that asked, by its title. Null: not named. */
  sessionTitle?: string | null;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const waitingText = useApprovalWaitingText(resolvers);
  // The panel's own rule: a pending call with no decision on offer waits on
  // someone else, so the region is not announced as a request to this viewer.
  const waiting = details.pending === true && !onDecision;
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="mx-auto w-full max-w-xl">
      <h2 id={titleId} className="sr-only">
        {waiting ? tI18nComplete.raw('textdb0e960b68b5') : tI18nComplete.raw('text1862f81ed9d6')}
      </h2>
      <p className="sr-only">{waiting ? waitingText : tI18nComplete.raw('text32c6817c8380')}</p>
      <div className="border-border overflow-hidden rounded-xl border">
        <ApprovalDecisionPanel
          details={details}
          outcome={null}
          busyDecision={busyDecision}
          error={null}
          onDecision={onDecision}
          onOpenSession={onOpenSession}
          previewAuthorized={previewAuthorized}
          resolvers={resolvers}
          agentName={agentName}
          sessionTitle={sessionTitle}
        />
      </div>
    </section>
  );
}
