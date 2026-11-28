'use client';

import { useTranslations } from '../../i18n';
/**
 * A turn's outcomes, rendered in its footer.
 *
 * ALWAYS VISIBLE, unlike the Copy / turn-meta bar beside it which reveals on
 * hover. A hidden record of a schedule the agent created is a trust bug: the
 * whole point of the card is that a durable side effect cannot happen quietly.
 *
 * Capped at four. A long tool-heavy turn can produce a lot, and a footer that
 * outgrows its response has inverted the page. The overflow count says so
 * ("N more in this session") and nothing re-renders those cards elsewhere.
 */

import { ItemGroup } from '../../primitives/item';

import { useProjectContext } from '../../files/project/context';
import { OutcomeCard } from '../../internal/outcomes/outcome-card';
import type { Outcome } from '../../internal/outcomes/outcome-types';
import { ChangeRequestLinkCard } from './change-request-link-card';
import { linkedChangeRequestIds } from './change-request-links';
import { useOutcomeOpen, useTurnOutcomes } from './session-outcomes-provider';

export const MAX_VISIBLE_OUTCOMES = 4;

/** Pure, so the cap is testable without a DOM. */
export function visibleOutcomes(outcomes: Outcome[]): { shown: Outcome[]; overflow: number } {
  if (outcomes.length <= MAX_VISIBLE_OUTCOMES) return { shown: outcomes, overflow: 0 };
  return {
    shown: outcomes.slice(0, MAX_VISIBLE_OUTCOMES),
    overflow: outcomes.length - MAX_VISIBLE_OUTCOMES,
  };
}

/**
 * `text`: the turn's reply. A change request it links to (a Review link,
 * `id=cr:…`) that the turn did not open itself gets a card with its decision
 * (`ChangeRequestLinkCard`): a worker opened it, and the reply only points at it.
 */
export function TurnOutcomes({ turnKey, text }: { turnKey: string; text?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const outcomes = useTurnOutcomes(turnKey);
  const onOpen = useOutcomeOpen();
  const projectId = useProjectContext()?.projectId ?? '';
  const { shown, overflow } = visibleOutcomes(outcomes);
  const linked = projectId
    ? linkedChangeRequestIds(text).filter((crId) => !outcomes.some((outcome) => outcome.id === `cr:${crId}`))
    : [];

  // No outcomes, no footer. The overwhelming majority of turns take this path,
  // so it stays the cheapest one — no wrapper, no group, no separator.
  if (shown.length === 0 && linked.length === 0) return null;
  if (shown.length === 0) {
    return (
      <div data-testid="turn-linked-change-requests">
        {linked.map((crId) => (
          <ChangeRequestLinkCard key={crId} projectId={projectId} crId={crId} />
        ))}
      </div>
    );
  }

  return (
    <ItemGroup className="mt-3 gap-1.5" data-testid="turn-outcomes">
      {shown.map((outcome, index) => (
        <OutcomeCard key={outcome.id} outcome={outcome} index={index} onOpen={onOpen} />
      ))}
      {linked.map((crId) => (
        <ChangeRequestLinkCard key={crId} projectId={projectId} crId={crId} />
      ))}
      {overflow > 0 ? (
        <p className="text-muted-foreground px-1 text-xs">
          {overflow} {tI18nComplete.raw('text17ce60292e3f')}
        </p>
      ) : null}
    </ItemGroup>
  );
}
