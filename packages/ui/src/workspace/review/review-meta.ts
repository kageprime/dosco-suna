/**
 * Presentation metadata for Review Center items — the single place that maps a
 * kind / status / source to its icon, Dosco tone, and label. Uses the
 * tinted-icon-tile pattern: a faint Dosco-token fill behind a solid Dosco-token
 * icon.
 */

import { localizeUiCatalog } from '../../i18n/ui-catalog/localize-ui-catalog';
import { REVIEW_META_TRANSLATION_KEYS } from '../../i18n/ui-catalog/review-meta-translation-keys.generated';
import type { UiTranslator } from '../../i18n';
import {
  ArrowUUpLeftIcon as ArrowUUpLeft,
  ChatCircleDotsIcon as ChatCircleDots,
  ChatsIcon as ChatMessages,
  CheckCircleIcon as CheckCircleSolid,
  CircleHalfIcon as CircleHalf,
  CircleIcon,
  CommandIcon as Command,
  CreditCardIcon as CreditCardSolid,
  DatabaseIcon as Database,
  FileTextIcon as FileText,
  GitMergeIcon as GitMerge,
  GitPullRequestIcon as GitPullRequest,
  HourglassIcon as Hourglass,
  ListChecksIcon as ListChecks,
  ProhibitIcon as Prohibit,
  XCircleIcon as XCircle,
  MonitorIcon as Monitor,
  PaperPlaneTiltIcon as Send,
  ShieldCheckIcon as ShieldCheckSolid,
  SparkleIcon as SparklesSolid,
  TerminalWindowIcon as Terminal,
} from '@phosphor-icons/react';
import { createElement, type ComponentType } from 'react';
import type {
  ApprovalActionIcon,
  ReviewKind,
  ReviewSource,
  ReviewStatus,
} from './types';

type IconCmp = ComponentType<{ className?: string }>;

/** Wraps a fill-intent icon so the tinted-icon-tile pattern (see file header)
 *  always renders it solid, without forcing `weight="fill"` on every icon
 *  this module re-exports (`GitPullRequest`, `Monitor`, `Send`, … stay
 *  outline). */
function filled(IconComponent: IconCmp): IconCmp {
  const Fillable = IconComponent as ComponentType<{ className?: string; weight?: 'fill' }>;
  return function FilledIcon({ className }: { className?: string }) {
    return createElement(Fillable, { className, weight: 'fill' });
  };
}

/** Same as `filled`, at `bold`: an open ring that holds its weight at 16 px. */
function bold(IconComponent: IconCmp): IconCmp {
  const Weighted = IconComponent as ComponentType<{ className?: string; weight?: 'bold' }>;
  return function BoldIcon({ className }: { className?: string }) {
    return createElement(Weighted, { className, weight: 'bold' });
  };
}
type BadgeVariant =
  'success' | 'warning' | 'destructive' | 'secondary' | 'muted' | 'kortix' | 'outline' | 'info';

/** Each kind's name. Its glyph and tint live in `ROW_TILE`. */
export const KIND_META: Record<ReviewKind, { label: string }> = {
  change: { label: 'Change' },
  approval: { label: 'Approval' },
  output: { label: 'Output' },
  decision: { label: 'Question' },
  batch: { label: 'Finished' },
};

// Every chip in the Review Center is the one `Badge` component — no second
// pill family (Jay, 2026-09-03: "use the badge component only").
/** A change's verification entries carry a tone; map it onto the Badge variant. */
export const VERIFICATION_BADGE: Record<'success' | 'warning' | 'neutral' | 'info', BadgeVariant> =
  {
    success: 'success',
    warning: 'warning',
    neutral: 'secondary',
    info: 'info',
  };

export const STATUS_META: Record<ReviewStatus, { label: string; badge: BadgeVariant }> = {
  needs_you: { label: 'Needs you', badge: 'warning' },
  waiting: { label: 'Waiting on agent', badge: 'secondary' },
  approved: { label: 'Approved', badge: 'success' },
  changes_requested: { label: 'Changes requested', badge: 'warning' },
  rejected: { label: 'Rejected', badge: 'destructive' },
  done: { label: 'Done', badge: 'success' },
  dismissed: { label: 'Dismissed', badge: 'muted' },
  expired: { label: 'Expired', badge: 'muted' },
};

export const SOURCE_META: Record<ReviewSource, { label: string; icon: IconCmp }> = {
  web: { label: 'Web', icon: Monitor },
  slack: { label: 'Slack', icon: ChatMessages },
  agent: { label: 'Agent', icon: filled(SparklesSolid) },
};

export const APPROVAL_ACTION_ICON: Record<ApprovalActionIcon, IconCmp> = {
  email: Send,
  charge: filled(CreditCardSolid),
  command: Terminal,
  data: Database,
  generic: Command,
};

/**
 * The inbox row's leading tile: a filled glyph names the kind, the
 * tint says it waits on you. A decided or waiting row goes neutral, so the
 * colored tiles in the list are exactly the rows that need you. Purple stays
 * reserved for the owner role (kortix-brand color law), so no kind uses it.
 */
export const ROW_TILE: Record<ReviewKind, { icon: IconCmp; tint: string }> = {
  change: { icon: filled(GitPullRequest), tint: 'bg-kortix-blue/15 text-kortix-blue' },
  approval: { icon: filled(ShieldCheckSolid), tint: 'bg-kortix-orange/15 text-kortix-orange' },
  output: { icon: filled(FileText), tint: 'bg-kortix-blue/15 text-kortix-blue' },
  decision: { icon: filled(ChatCircleDots), tint: 'bg-kortix-yellow/15 text-kortix-yellow' },
  batch: { icon: filled(ListChecks), tint: 'bg-kortix-green/15 text-kortix-green' },
};

/** The neutral tile of a row that no longer needs you. */
export const ROW_TILE_NEUTRAL = 'bg-muted text-muted-foreground';

/**
 * The status glyph in the row's right column:
 * open ring = yours to do, half = the agent is on it, then where it landed.
 * A person's "no" is orange, never red: red reports a failure.
 */
export const ROW_STATUS_GLYPH: Record<ReviewStatus, { icon: IconCmp; className: string }> = {
  needs_you: { icon: bold(CircleIcon), className: 'text-kortix-blue' },
  waiting: { icon: filled(CircleHalf), className: 'text-kortix-yellow' },
  approved: { icon: filled(CheckCircleSolid), className: 'text-kortix-green' },
  done: { icon: filled(CheckCircleSolid), className: 'text-kortix-green' },
  changes_requested: { icon: ArrowUUpLeft, className: 'text-kortix-orange' },
  rejected: { icon: Prohibit, className: 'text-kortix-orange' },
  dismissed: { icon: filled(XCircle), className: 'text-muted-foreground' },
  expired: { icon: Hourglass, className: 'text-muted-foreground' },
};

/** A merged change reads as a merge, not a generic check. */
export const ROW_MERGED_GLYPH = { icon: GitMerge, className: 'text-kortix-green' } as const;

export const SEGMENT_LABEL = {
  needs_you: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
} as const;

export function getLocalizedReviewMeta(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { KIND_META, STATUS_META, SOURCE_META, SEGMENT_LABEL },
    tI18nComplete,
    REVIEW_META_TRANSLATION_KEYS,
  );
}

export function reviewKindLabel(kind: ReviewKind, tI18nComplete: UiTranslator): string {
  return getLocalizedReviewMeta(tI18nComplete).KIND_META[kind].label;
}

export function reviewStatusLabel(status: ReviewStatus, tI18nComplete: UiTranslator): string {
  return getLocalizedReviewMeta(tI18nComplete).STATUS_META[status].label;
}
