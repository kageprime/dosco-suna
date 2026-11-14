'use client';

import { newSessionHref } from '../../lib/routes';
import { UiLink } from '../../providers/ui-provider';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { InlineMeta } from '../../primitives/inline-meta';
import { useTranslations } from '../../i18n';

/** Pending text stays legible while the active turn continues above it. */
export const QUEUED_BUBBLE_OPACITY_CLASS =
  '[&_.text-foreground]:text-muted-foreground [&_p]:text-muted-foreground';

/** `interrupted`: the runtime holds the message but a Stop ended the turn
 *  before a step opened under it — it runs with the next send. */
export type QueuedPromptState = 'queued' | 'interrupted';

export type QueuedPromptStatusState = QueuedPromptState | 'failed' | 'sending' | 'held';

/** Ring tone for a queued bubble. `pending` covers waiting and sending, so a
 *  delivery retry that flips a row between them never changes the ring. */
type QueuedBubbleTone = 'pending' | 'held' | 'failed';

export function queuedBubbleTone(
  state: QueuedPromptStatusState | null | undefined,
): QueuedBubbleTone | undefined {
  if (!state) return undefined;
  if (state === 'failed' || state === 'held') return state;
  return 'pending';
}

/** Show delivery progress on the message itself, not only on the send button. */
export function QueuedPromptProgress({ state }: { state: 'queued' | 'sending' | 'interrupted' }) {
  const t = useTranslations('threads');
  return (
    <InlineMeta>
      <span role="status" data-queued-status={state} className="text-muted-foreground text-xs">
        {state === 'sending' ? t('sending') : t('queued')}
      </span>
    </InlineMeta>
  );
}

/**
 * A delivery failure retains its cause and recovery actions.
 */
export function QueuedPromptFailure({
  lastError,
  onRetry,
  onRemove,
}: {
  lastError?: string | null;
  onRetry?: () => void;
  onRemove?: () => void;
}) {
  const copy = useTranslations('hardcodedUi.i18nComplete');
  const common = useTranslations('common');
  return (
    <InlineMeta>
      <span data-queued-status="failed" className="flex items-center gap-1">
        <span className="text-kortix-red" role="status" title={lastError ?? undefined}>
          {copy.raw('textcd5f943d5863')}
          {lastError ? ` — ${lastError}` : ''}
        </span>
        {onRetry && (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            {copy.raw('text942087cc2d41')}
          </Button>
        )}
        {onRemove && (
          <Button type="button" variant="ghost" size="xs" onClick={onRemove}>
            {common('remove')}
          </Button>
        )}
      </span>
    </InlineMeta>
  );
}

/** A failed callback path requires a new computer, not a retry on the old one. */
export function QueuedPromptRecovery({ projectId, onRemove }: {
  projectId?: string;
  onRemove?: () => void;
}) {
  const sidebar = useTranslations('sidebar');
  const turn = useTranslations('sessionUi.turn');
  const common = useTranslations('common');
  const newSession = projectId ? (
    <Button variant="ghost" size="xs" asChild>
      <UiLink href={newSessionHref(projectId)}>{sidebar('newSession')}</UiLink>
    </Button>
  ) : null;
  const remove = onRemove ? (
    <Button type="button" variant="ghost" size="xs" onClick={onRemove}>{common('remove')}</Button>
  ) : null;
  return (
    <div data-queued-status="failed" className="flex flex-col items-end gap-1">
      <span role="status" className="text-kortix-red text-xs">{turn('computerDisconnected')}</span>
      {newSession && remove ? <ButtonGroup>{newSession}{remove}</ButtonGroup> : newSession ?? remove}
    </div>
  );
}
