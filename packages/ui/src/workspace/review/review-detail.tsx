'use client';

import { useTranslations } from '../../i18n';
/**
 * Review Center — one item, in the inbox's detail pane (`ReviewDetail`): a
 * toolbar with the kind, state and verdicts, then the title, the facts, the
 * kind's body and, for a change, the live file diffs.
 *
 * Actions mutate parent state optimistically via the passed handlers.
 */

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '../../primitives/item';
import { Kbd } from '../../primitives/kbd';
import Loading from '../../primitives/loading';
import { DiffStat } from '../../primitives/status';
import { infoToast, successToast } from '../../primitives/toast';
import { useProjectContext } from '../../files/project/context';
import { getFileIcon } from '../../files/project/components/file-icon';
import {
  useChangeRequestDiff,
  useChangeRequestMergePreview,
} from '../../files/project/hooks/use-change-requests';
import { ShowContentRenderer } from '../../files/renderers/show-content-renderer';
import { getShowFileCategory } from '../../files/renderers/show-type-utils';
import {
  SessionDriveFilesScope,
  sessionDriveMountPath,
} from '../../internal/files/session-drive-files';
import { useFilePreviewStore } from '../../internal/stores/file-preview-store';
import { cn } from '../../internal/lib/utils';
import type { ReviewVerdict } from '@kortix/sdk';
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowUpRightIcon as ArrowUpRight,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircleSolid,
  EyeIcon as Eye,
  SparkleIcon as SparklesSolid,
  XIcon as X,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { ChangeFiles } from './change-files';
import { formatItemAgeLong } from './review-actions';
import {
  APPROVAL_ACTION_ICON,
  ROW_TILE,
  ROW_TILE_NEUTRAL,
  STATUS_META,
  VERIFICATION_BADGE,
  reviewKindLabel,
  reviewStatusLabel,
} from './review-meta';
import { type ApprovalAction, type ReviewItem, type ReviewStatus, isSafeRisk } from './types';

export interface ReviewActions {
  resolve: (id: string, status: ReviewStatus, toast?: string, feedback?: string) => void;
  decideAction: (itemId: string, actionId: string, decision: 'approved' | 'denied') => void;
  /** Open the item's originating session (e.g. to watch the agent revise). */
  openSession?: (sessionId: string) => void;
  /** Live-data mode: verdicts go to the server through `resolve()`. */
  connected?: boolean;
  /** The review item id currently mid-mutation, if any — drives the
   *  per-item `Loading` state on Approve/Deny while connected. */
  pendingId?: string | null;
  /** Which verdict `pendingId`'s in-flight mutation is — so Approve and Deny
   *  don't both show `Loading` at once. */
  pendingDecision?: 'approve' | 'deny' | null;
  /** Start a real session from the blocked Change Request head branch. */
  recoverChange?: (item: Extract<ReviewItem, { kind: 'change' }>, conflicts: string[]) => void;
  recoveringCrId?: string | null;
  /** Whether this viewer may give `verdict` on `item` (KRTX-1720): the inbox's
   *  `reviewVerdictAllowed` over the viewer's leaves. A control for a verdict
   *  it refuses does not render. */
  allows: (item: ReviewItem, verdict: ReviewVerdict) => boolean;
}

/** A muted bordered panel — the friendly content surface. */
function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('bg-popover rounded-md border px-4 py-3.5', className)}>{children}</div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground mb-2 text-sm font-semibold">{children}</div>;
}

// ── change ────────────────────────────────────────────────────────────────
function ChangeBody({
  item,
  actions,
  onClose,
  conflicts,
}: {
  item: Extract<ReviewItem, { kind: 'change' }>;
  actions: ReviewActions;
  onClose: () => void;
  conflicts: string[];
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  const whatChanged = d.whatChanged ?? [];
  const verification = d.verification ?? [];
  const requested = d.requestedChanges ?? [];
  const recovering = actions.recoveringCrId === d.crId;
  return (
    <>
      {requested.length > 0 && (
        <Item variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>{tI18nComplete.raw('textb0eabce39690')}</ItemTitle>
            <ul className="text-foreground list-disc space-y-1 pl-5 text-sm">
              {requested.map((r) => (
                <li key={r.at ?? r.text} className="text-pretty">
                  {r.text}
                </li>
              ))}
            </ul>
            <ItemDescription>{tI18nComplete.raw('texte648ea58ae80')}</ItemDescription>
          </ItemContent>
          {item.sessionId && actions.openSession ? (
            <ItemActions>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  actions.openSession?.(item.sessionId as string);
                  onClose();
                }}
              >
                {tI18nComplete.raw('textd1636c646e66')}
              </Button>
            </ItemActions>
          ) : null}
        </Item>
      )}

      {(whatChanged.length > 0 || d.impact) && (
        <div className="space-y-2">
          {whatChanged.length > 0 && (
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
              {whatChanged.map((line) => (
                <li key={line} className="text-pretty">
                  {line}
                </li>
              ))}
            </ul>
          )}
          {d.impact && <p className="text-muted-foreground text-sm text-pretty">{d.impact}</p>}
        </div>
      )}

      {(verification.length > 0 || d.previewUrl) && (
        <Item variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>{tI18nComplete.raw('text7140f4f19dec')}</ItemTitle>
            {verification.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {verification.map((v) => (
                  <Badge key={v.label} variant={VERIFICATION_BADGE[v.tone]} size="sm">
                    {v.label}
                  </Badge>
                ))}
              </div>
            )}
          </ItemContent>
          {d.previewUrl && (
            <ItemActions>
              <Button variant="outline" size="sm" asChild>
                <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
                  {tI18nComplete.raw('textf7afe3dde18c')}
                </a>
              </Button>
            </ItemActions>
          )}
        </Item>
      )}

      {conflicts.length > 0 && (
        <Item variant="warning" size="sm">
          <ItemContent>
            <ItemTitle>
              {tI18nComplete.raw('text62e2514edc8d')} {conflicts.length}{' '}
              {conflicts.length === 1 ? 'file' : 'files'}
            </ItemTitle>
            <ItemDescription>{tI18nComplete.raw('text0ffc4db692f7')}</ItemDescription>
          </ItemContent>
          {/* The fix stands in for Ship it, so it follows the merge verdict. */}
          {actions.allows(item, 'approve') ? (
            <ItemActions>
              <Button
                size="sm"
                disabled={recovering}
                onClick={() => {
                  if (actions.recoverChange) {
                    actions.recoverChange(item, conflicts);
                  } else {
                    actions.resolve(item.id, 'waiting', tI18nComplete.raw('text92bb0a437a39'));
                    onClose();
                  }
                }}
              >
                {recovering ? <Loading className="size-3.5 shrink-0" /> : null}
                {tI18nComplete.raw('text30afafe4c16e')}
              </Button>
            </ItemActions>
          ) : null}
        </Item>
      )}
    </>
  );
}

// ── approval ──────────────────────────────────────────────────────────────
// Connector calls never reach this page: the inbox opens them in
// `ApprovalDecisionPane`. What is left here is the native multi-action approval.
function ApprovalActionRow({
  action,
  connected,
  pending,
  readOnly,
  onApprove,
  onDeny,
  onOpenSession,
}: {
  action: ApprovalAction;
  connected?: boolean;
  /** 'approve' | 'deny' while this row's own mutation is in flight. */
  pending?: 'approve' | 'deny' | null;
  /** Display-only row — the decision lives elsewhere (the whole-item bar for
   *  connected multi-action approvals, where one verdict covers every row). */
  readOnly?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onOpenSession?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const Icon = APPROVAL_ACTION_ICON[action.icon];
  const safe = isSafeRisk(action.risk);
  const args = action.argsPreview ?? [];
  const busy = !!pending;
  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-sm',
            safe ? 'bg-kortix-green/15' : 'bg-kortix-orange/15',
          )}
        >
          <Icon className={cn('size-5', safe ? 'text-kortix-green' : 'text-kortix-orange')} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground text-sm font-medium">{action.title}</span>
          </div>
          <div className="text-muted-foreground mt-0.5 text-sm text-pretty">
            {action.consequence}
          </div>
          {/* The concrete arguments — recipients, amount, command — so the human
              decides on the real thing, not just the verb. */}
          {args.length > 0 && (
            <dl className="border-border/60 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-2 text-xs">
              {args.map((a) => (
                <div key={a.key} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted-foreground font-mono">{a.key}</dt>
                  <dd className="text-foreground truncate font-mono" title={a.value}>
                    {a.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono">
              {action.connector} · {action.action}
            </span>
            <span>{tI18nComplete.raw('text3b9453dad42b')}</span>
            <span>{action.policySource}</span>
          </div>
        </div>
        <div className="shrink-0">
          {action.decided ? (
            <Badge variant={action.decided === 'approved' ? 'success' : 'destructive'} size="sm">
              {action.decided === 'approved' ? 'Approved' : 'Denied'}
            </Badge>
          ) : readOnly ? null : (
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" disabled={busy} onClick={onDeny}>
                  {pending === 'deny' ? <Loading className="size-3.5 shrink-0" /> : null}
                  {tI18nComplete.raw('text05a2d7332eb9')}
                </Button>
                <Button size="sm" disabled={busy} onClick={onApprove}>
                  {pending === 'approve' ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {tI18nComplete.raw('text6007acbe30b2')}
                </Button>
              </div>
              {connected && onOpenSession ? (
                <button
                  type="button"
                  onClick={onOpenSession}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                >
                  {tI18nComplete.raw('textf42e280577fb')}
                  <ArrowUpRight className="size-3" />
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalBody({
  item,
  actions,
  onResolved,
}: {
  item: Extract<ReviewItem, { kind: 'approval' }>;
  actions: ReviewActions;
  /** The item got its verdict: the inbox moves on to the next row. */
  onResolved: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const list = item.detail.actions ?? [];
  const openSession =
    actions.openSession && item.sessionId
      ? () => actions.openSession?.(item.sessionId as string)
      : undefined;
  return (
    <>
      {/* Native multi-action approvals resolve as one item. */}
      {(() => {
        const wholeItem = !!actions.connected && list.filter((a) => !a.decided).length > 1;
        const busy = actions.connected && actions.pendingId === item.id;
        // Approve and deny assert the same leaves on a native item.
        const decides = actions.allows(item, 'approve');
        return (
          <>
            <div className="space-y-2">
              {list.map((a) => (
                <ApprovalActionRow
                  key={a.id}
                  action={a}
                  connected={actions.connected}
                  readOnly={wholeItem || !decides}
                  pending={busy && !wholeItem ? (actions.pendingDecision ?? 'approve') : null}
                  onOpenSession={openSession}
                  onApprove={() => {
                    if (actions.connected) {
                      actions.resolve(item.id, 'approved', `Approved · ${a.title}`);
                      onResolved();
                      return;
                    }
                    actions.decideAction(item.id, a.id, 'approved');
                    successToast(tI18nComplete('text6ef671b81187', { value0: a.title }));
                  }}
                  onDeny={() => {
                    if (actions.connected) {
                      actions.resolve(item.id, 'rejected', `Denied · ${a.title}`);
                      onResolved();
                      return;
                    }
                    actions.decideAction(item.id, a.id, 'denied');
                    infoToast(tI18nComplete('text6ef671b81187', { value0: a.title }));
                  }}
                />
              ))}
            </div>
            {wholeItem && decides && (
              <div className="bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
                <p className="text-muted-foreground min-w-0 text-sm text-pretty">
                  {tI18nComplete.raw('text91273d498d36')} {list.length}{' '}
                  {tI18nComplete.raw('text9a24d7803caa')}
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      actions.resolve(item.id, 'rejected', `Denied all ${list.length} actions`);
                      onResolved();
                    }}
                  >
                    {busy && actions.pendingDecision === 'deny' ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : null}
                    {tI18nComplete.raw('text5a41803b2dd1')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      actions.resolve(item.id, 'approved', `Approved all ${list.length} actions`);
                      onResolved();
                    }}
                  >
                    {busy && actions.pendingDecision === 'approve' ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    {tI18nComplete.raw('textae067b687107')}
                  </Button>
                </div>
              </div>
            )}
          </>
        );
      })()}
    </>
  );
}

// ── output ────────────────────────────────────────────────────────────────
/** File kinds an output draws inline. Everything else is a row that opens it. */
const INLINE_MEDIA = new Set(['image', 'video', 'audio']);

/** One file of an output: its label and name, and when it can be read, a
 *  button that opens it in the file preview. */
function OutputFileRow({
  file,
  readable,
}: {
  file: { path: string; note?: string };
  readable: boolean;
}) {
  const name = file.path.split('/').pop() || file.path;
  const body = (
    <>
      {getFileIcon(name, { className: 'text-muted-foreground size-4 shrink-0' })}
      <span className="text-foreground truncate text-sm">{file.note ?? name}</span>
      {file.note ? (
        <span className="text-muted-foreground truncate font-mono text-xs">{name}</span>
      ) : null}
    </>
  );
  return (
    <li title={file.path}>
      {readable ? (
        <button
          type="button"
          onClick={() => useFilePreviewStore.getState().openPreview(file.path)}
          className="hover:bg-hover duration-fast focus-visible:ring-ring flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5 px-2 py-1.5">{body}</div>
      )}
    </li>
  );
}

/**
 * The agent's note, then what it made: the first image, video or sound drawn
 * inline, its text, and every other file as a row. Nothing it made, no section.
 *
 * A `/drives/…` path reads through the item's session: its mounts name the
 * drive behind each path (`SessionDriveFilesScope`), exactly as in the
 * session. A workspace path needs a running box, which the inbox does not
 * have, so it is listed and not opened.
 */
function OutputBody({ item }: { item: Extract<ReviewItem, { kind: 'output' }> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const projectId = useProjectContext()?.projectId;
  const sessionId = item.sessionId;
  const d = item.detail;
  const files = d.files ?? [];
  const readable = (path: string) =>
    !!projectId && !!sessionId && sessionDriveMountPath(path) !== null;
  const media = files.find(
    (f) => readable(f.path) && INLINE_MEDIA.has(getShowFileCategory(f.path)),
  );
  const rest = files.filter((f) => f !== media);
  const video = !!media && getShowFileCategory(media.path) === 'video';
  return (
    <>
      {projectId && sessionId ? (
        <SessionDriveFilesScope projectId={projectId} sessionId={sessionId} />
      ) : null}
      {d.note ? (
        <p className="text-foreground text-sm whitespace-pre-wrap text-pretty">{d.note}</p>
      ) : null}
      {media ? (
        // A video takes a 16:9 box: the inline card's fixed height bars a
        // landscape cut top and bottom, worst on a phone.
        <div className={cn('overflow-hidden rounded-md border', video && 'aspect-video')}>
          <ShowContentRenderer type="file" path={media.path} fill={video} />
        </div>
      ) : null}
      {d.preview ? (
        <section>
          <SectionLabel>{tI18nComplete.raw('text526e0087cc3f')}</SectionLabel>
          <p className="text-foreground text-sm whitespace-pre-wrap text-pretty">{d.preview}</p>
        </section>
      ) : null}
      {rest.length > 0 ? (
        <section>
          <SectionLabel>{tI18nComplete.raw('textabc7e9892806')}</SectionLabel>
          <ul className="-mx-2 space-y-0.5">
            {rest.map((f) => (
              <OutputFileRow key={f.path} file={f} readable={readable(f.path)} />
            ))}
          </ul>
        </section>
      ) : null}
      {d.previewUrl ? (
        <Button variant="outline" size="sm" className="gap-1.5" asChild>
          <a href={d.previewUrl} target="_blank" rel="noopener noreferrer">
            {tI18nComplete.raw('textf7afe3dde18c')}
            <ArrowUpRight className="size-3.5 shrink-0" />
          </a>
        </Button>
      ) : null}
    </>
  );
}

// ── decision ──────────────────────────────────────────────────────────────
function DecisionBody({
  item,
  actions,
  onClose,
}: {
  item: Extract<ReviewItem, { kind: 'decision' }>;
  actions: ReviewActions;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  // Answered already, or this viewer may not answer: the options only read.
  const locked = item.status !== 'needs_you' || !actions.allows(item, 'answer');
  return (
    <>
      <Panel>
        <div className="text-foreground text-sm font-medium">{d.question}</div>
        {d.context && (
          <div className="text-muted-foreground mt-1.5 text-sm text-pretty">{d.context}</div>
        )}
      </Panel>
      <div className="space-y-2">
        {[...(d.options ?? [])]
          .sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0))
          .map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={locked}
              onClick={() => {
                actions.resolve(item.id, 'done', `Answered · ${opt.label} — agent resumed`);
                onClose();
              }}
              className={cn(
                'focus-visible:ring-kortix-blue w-full rounded-md border px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
                opt.recommended ? 'border-primary/40 bg-primary/[0.03]' : 'bg-popover',
                !locked && 'hover:border-primary/40 hover:bg-primary/[0.05] active:scale-[0.99]',
                locked && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-foreground text-sm font-medium">{opt.label}</span>
                {opt.recommended && (
                  <Badge variant="kortix" size="xs">
                    {tI18nComplete.raw('textd70604e84304')}
                  </Badge>
                )}
              </div>
              {opt.description && (
                <div className="text-muted-foreground mt-0.5 text-sm text-pretty">
                  {opt.description}
                </div>
              )}
            </button>
          ))}
      </div>
    </>
  );
}

// ── batch ─────────────────────────────────────────────────────────────────
function BatchBody({ item }: { item: Extract<ReviewItem, { kind: 'batch' }> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const d = item.detail;
  const children = d.children ?? [];
  const needsReview = children.filter((c) => c.status === 'needs_review').length;
  return (
    <>
      <Panel>
        <div className="text-foreground text-sm text-pretty">{d.note}</div>
      </Panel>
      <div>
        <SectionLabel>
          {children.length} {tI18nComplete.raw('texte97caf2c8a6f')} {needsReview}{' '}
          {tI18nComplete.raw('text967458798444')}
        </SectionLabel>
        <ul className="bg-popover divide-border max-h-72 divide-y overflow-y-auto rounded-md border">
          {children.map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 px-4 py-2">
              {c.status === 'done' ? (
                <CheckCircleSolid weight="fill" className="text-kortix-green size-4 shrink-0" />
              ) : (
                <Eye className="text-kortix-yellow size-4 shrink-0" />
              )}
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{c.title}</span>
              {c.status === 'needs_review' && (
                <Badge variant="warning" size="xs">
                  {tI18nComplete.raw('texta0de5719f595')}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ── actions ─────────────────────────────────────────────────────────────────
/** Optional free-text feedback returned to the agent when asking for changes. */
function FeedbackComposer({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="bg-popover space-y-2 rounded-md border px-4 py-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSend(text.trim());
          }
        }}
        rows={3}
        aria-label={tI18nComplete.raw('text2534e74d5120')}
        placeholder={tI18nComplete.raw('text2534e74d5120')}
        className="placeholder:text-muted-foreground w-full resize-none bg-transparent text-sm outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground mr-auto text-xs">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> {tI18nComplete.raw('text1044b2d7aa48')}
        </span>
        <Button variant="outline-ghost" size="sm" onClick={onCancel}>
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
        <Button size="sm" onClick={() => onSend(text.trim())}>
          {tI18nComplete.raw('text77a860cbc585')}
        </Button>
      </div>
    </div>
  );
}

/** The header's right-hand group: what you can do to this item right now. */
function ActionBar({
  item,
  actions,
  onBack,
  conflicts,
  checkingConflicts,
  composing,
  setComposing,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onBack: () => void;
  conflicts: string[];
  checkingConflicts: boolean;
  composing: boolean;
  setComposing: (v: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Decisions and native approvals decide inside their body, with their own session link.
  if (item.kind === 'decision' || item.kind === 'approval') {
    return item.status === 'needs_you' ? null : (
      <span className="text-muted-foreground text-xs">
        {reviewStatusLabel(item.status, tI18nComplete)} · {formatItemAgeLong(item.createdAt)}
      </span>
    );
  }
  // The session that produced this item is where its reasoning lives.
  const openSession =
    item.sessionId && actions.openSession ? (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => actions.openSession?.(item.sessionId as string)}
      >
        {tI18nComplete.raw('textb205bb47f81a')}
      </Button>
    ) : null;
  if (item.status !== 'needs_you') {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-muted-foreground text-xs">
          {reviewStatusLabel(item.status, tI18nComplete)} · {formatItemAgeLong(item.createdAt)}
        </span>
        {openSession}
      </div>
    );
  }

  // change · output · batch. Each control shows only for a verdict the viewer
  // may give (KRTX-1720). Ship it on a change merges it; the conflict fix stands
  // in for Ship it, so it follows the same verdict.
  const secondaryLabel = item.secondaryAction;
  const hasConflicts = item.kind === 'change' && conflicts.length > 0;
  const showPrimary = actions.allows(item, 'approve');

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {openSession}
      {secondaryLabel && !composing && actions.allows(item, 'changes') && (
        <Button variant="ghost" size="sm" onClick={() => setComposing(true)}>
          {secondaryLabel}
        </Button>
      )}
      {!showPrimary ? null : hasConflicts && item.kind === 'change' ? (
        <Button
          size="sm"
          disabled={actions.recoveringCrId === item.detail.crId}
          onClick={() => {
            if (actions.recoverChange) {
              actions.recoverChange(item, conflicts);
            } else {
              actions.resolve(item.id, 'waiting', tI18nComplete.raw('text92bb0a437a39'));
              onBack();
            }
          }}
        >
          {actions.recoveringCrId === item.detail.crId ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <SparklesSolid weight="fill" className="size-3.5 shrink-0" />
          )}
          {tI18nComplete.raw('text30afafe4c16e')}
        </Button>
      ) : (
        <Button
          size="sm"
          // Ready to ship reads as success. Only high risk keeps the brake.
          variant={item.risk === 'high' ? 'danger' : checkingConflicts ? 'warning' : 'success'}
          disabled={checkingConflicts}
          onClick={() => {
            actions.resolve(item.id, 'approved', `${item.primaryAction} · done`);
            onBack();
          }}
        >
          {checkingConflicts ? <Loading className="size-3.5 shrink-0" /> : null}
          {checkingConflicts ? tI18nComplete.raw('textec963ffc911b') : item.primaryAction}
        </Button>
      )}
    </div>
  );
}

/** `main ← feat/branch · 1 file · +38 −2` — the facts a reviewer scans first. */
function ChangeFacts({ item }: { item: Extract<ReviewItem, { kind: 'change' }> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const adv = item.detail.advanced;
  const crId = item.detail.crId ?? null;
  // The live diff query is shared with `ChangeFiles` below (same key), so this
  // costs no extra request; it just lets the header agree with the file list.
  const diff = useChangeRequestDiff(crId);
  const files = diff.data?.files_changed ?? adv.files.length;
  const additions = diff.data?.additions ?? adv.additions;
  const deletions = diff.data?.deletions ?? adv.deletions;
  const hasRefs = Boolean(adv.baseRef || adv.headRef);
  const hasCounts = files > 0 || additions > 0 || deletions > 0;
  if (!hasRefs && !hasCounts) return null;
  return (
    <>
      {hasRefs && (
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="border-0 align-middle font-mono ring-0" size="sm">
            {adv.baseRef || '—'}
          </Badge>
          <ArrowLeft
            className="text-muted-foreground size-3.5 shrink-0"
            aria-label={tI18nComplete.raw('text75857a458999')}
          />
          <Badge
            variant="secondary"
            size="sm"
            className="line-clamp-1 max-w-96 truncate border-0 align-middle font-mono ring-0"
          >
            <span className="truncate">{adv.headRef || '—'}</span>
          </Badge>
        </span>
      )}
      {files > 0 && (
        <span className="tabular-nums">
          {files} {files === 1 ? 'file' : 'files'}
        </span>
      )}
      <DiffStat additions={additions} deletions={deletions} />
    </>
  );
}

/** The plain-language body for the item's kind: the page's and the modal's. */
function KindBody({
  item,
  actions,
  onClose,
  conflicts,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onClose: () => void;
  conflicts: string[];
}) {
  switch (item.kind) {
    case 'change':
      return <ChangeBody item={item} actions={actions} onClose={onClose} conflicts={conflicts} />;
    case 'approval':
      return <ApprovalBody item={item} actions={actions} onResolved={onClose} />;
    case 'output':
      return <OutputBody item={item} />;
    case 'decision':
      return <DecisionBody item={item} actions={actions} onClose={onClose} />;
    case 'batch':
      return <BatchBody item={item} />;
  }
}

/** "Ask for changes" with an optional note, sent back to the agent. */
function ChangesComposer({
  item,
  actions,
  onCancel,
  onSent,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onCancel: () => void;
  onSent: () => void;
}) {
  return (
    <FeedbackComposer
      onCancel={onCancel}
      onSend={(text) => {
        actions.resolve(
          item.id,
          'changes_requested',
          text ? `Sent to the agent: “${text}”` : `${item.secondaryAction} — sent to the agent`,
          text || undefined,
        );
        onSent();
      }}
    />
  );
}

/**
 * Leaves the open item. On a narrow inbox it is Back to the list; with both
 * panes it is Close, which brings the empty pane (and the asks deck) back.
 * `part` renders one of the two where a toolbar places them apart.
 */
export function ClosePaneButton({
  onClick,
  part = 'both',
}: {
  onClick: () => void;
  part?: 'back' | 'close' | 'both';
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      {part !== 'close' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={tI18nComplete.raw('text76900f1bfd16')}
          className="text-muted-foreground -ml-1.5 @3xl/inbox:hidden"
        >
          <ArrowLeft className="size-4" />
        </Button>
      ) : null}
      {part !== 'back' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={tI18nComplete.raw('text7d9eb7acb13e')}
          className="text-muted-foreground -mr-1.5 hidden @3xl/inbox:inline-flex"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </>
  );
}

/**
 * One review item in the inbox's detail pane. A sticky toolbar names the kind
 * and state and holds the verdicts; below it the title, the facts, the body
 * and (for a change) the file diffs. Every kind but a connector call renders
 * here; a connector call renders `ApprovalDecisionPane`.
 *
 * `onBack` returns to the list on a narrow inbox (the Back button shows only
 * below the two-pane width). `onResolved` runs after a verdict: the inbox
 * moves on to the next row.
 */
export function ReviewDetail({
  item,
  actions,
  onBack,
  onResolved,
}: {
  item: ReviewItem;
  actions: ReviewActions;
  onBack: () => void;
  onResolved: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const crId = item.kind === 'change' ? (item.detail.crId ?? null) : null;
  const mergePreview = useChangeRequestMergePreview(crId, Boolean(crId));
  const [composing, setComposing] = useState(false);

  const previewHasConflicts = Boolean(
    mergePreview.data && !mergePreview.data.is_up_to_date && !mergePreview.data.can_merge,
  );
  const conflicts =
    item.kind === 'change'
      ? crId
        ? previewHasConflicts
          ? (mergePreview.data?.conflicts ?? [])
          : []
        : (item.detail.conflicts ?? [])
      : [];
  const tile = ROW_TILE[item.kind];
  const number = item.kind === 'change' ? item.detail.number : undefined;
  // A change waiting on you is "Open", the way a pull request is; every other
  // state keeps the inbox's own label.
  const open = item.status === 'needs_you' && item.kind === 'change';
  const statusLabel = open
    ? tI18nComplete.raw('texted077f3d8125')
    : reviewStatusLabel(item.status, tI18nComplete);
  const statusBadge = open ? 'success' : STATUS_META[item.status].badge;
  const secondaryLabel = item.secondaryAction;

  return (
    <article className="flex min-h-full w-full flex-col">
      {/* The pane's toolbar: what this is and its state on the left, what you
          can do on the right. It stays put while the body scrolls. */}
      <header className="border-border bg-background sticky top-0 z-10 flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
        <ClosePaneButton onClick={onBack} part="back" />
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-sm',
            item.status === 'needs_you' ? tile.tint : ROW_TILE_NEUTRAL,
          )}
        >
          <tile.icon className="size-3.5" />
        </span>
        <span className="text-muted-foreground truncate text-sm">
          {item.kind === 'change' ? item.project : reviewKindLabel(item.kind, tI18nComplete)}
          {number != null && <span className="tabular-nums"> #{number}</span>}
        </span>
        <Badge variant={statusBadge} size="sm" className="shrink-0">
          {statusLabel}
        </Badge>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ActionBar
            item={item}
            actions={actions}
            onBack={onResolved}
            conflicts={conflicts}
            checkingConflicts={Boolean(crId) && mergePreview.isLoading}
            composing={composing}
            setComposing={setComposing}
          />
          <ClosePaneButton onClick={onBack} part="close" />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-6 pt-6 pb-10">
        <div className="space-y-2">
          <h1 className="text-foreground text-xl font-semibold tracking-tight text-pretty wrap-anywhere">
            {item.title}
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
            <span>{item.agent}</span>
            {item.kind === 'change' && <ChangeFacts item={item} />}
            <span>{formatItemAgeLong(item.createdAt)}</span>
          </div>
        </div>

        <div className="mt-8 space-y-8">
          {composing && secondaryLabel && item.kind !== 'approval' && (
            <ChangesComposer
              item={item}
              actions={actions}
              onCancel={() => setComposing(false)}
              onSent={onResolved}
            />
          )}

          <section className="space-y-3">
            <h2 className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('text526e0087cc3f')}
            </h2>
            <div className="space-y-4">
              <KindBody item={item} actions={actions} onClose={onResolved} conflicts={conflicts} />
            </div>
          </section>

          {crId && <ChangeFiles crId={crId} />}
        </div>
      </div>
    </article>
  );
}
