/**
 * Who started the RUN a session belongs to. Both hosts
 * (`packages/ui/src/workspace/projects/session-starter.ts`,
 * `apps/mobile/lib/session/session-tree.ts`) derive their presentation from
 * this classification: mobile its `StarterIcon` table and "You"/"Member"
 * wording, web its `labels.you`/`labels.unknown` and owner fallbacks. It
 * reads the server-derived `initiator` (never from `created_by` alone: a
 * child keeps its creator's ownership but shows its run's starter). A row
 * the backfill could not classify has no initiator and reads as a member:
 * the session's creator.
 */

export type SessionStarterType = 'member' | 'trigger' | 'channel' | 'api' | 'system';

/** The server-derived run starter; mirrors the SDK's `ProjectSessionInitiator`. */
export interface SessionInitiator {
  type: SessionStarterType;
  /** member: user id · trigger: slug · channel: 'slack'|'teams'|'email'|'telegram' · api: service account id · system: source. */
  id: string | null;
  /** Display label: member name, trigger slug, channel name, service account name, or 'Kortix'. */
  label: string | null;
}

/** The fields of a session row the classification reads; mirrors `ProjectSession`. */
export interface SessionStarterInput {
  initiator?: SessionInitiator | null;
  created_by?: string | null;
  is_owner?: boolean;
}

export interface SessionStarterCore {
  type: SessionStarterType;
  /** member: the initiator's user id, else the row's creator · trigger: slug · channel: channel id · api: service-account id · system: source. */
  id: string | null;
  /** The initiator's display label; null when it has none. Hosts add their own wording and fallbacks. */
  label: string | null;
  /** A member starter that is the viewer. Hosts turn it into their "You" wording. */
  isViewer: boolean;
}

/**
 * The common core of "who started the run". The `isViewer` rule: the starter
 * is the viewer when the initiator's own id — else the row's creator, the
 * backfill fallback — names the viewer, and either the initiator itself names
 * them or the row's `is_owner` agrees (the server derives `is_owner` from
 * that same comparison; a row served without it keeps the id comparison). A
 * row that names no viewer is never "You".
 */
export function classifySessionStarter(
  session: SessionStarterInput,
  viewerId: string | null | undefined,
): SessionStarterCore {
  const initiator = session.initiator ?? null;
  if (!initiator || initiator.type === 'member') {
    // No initiator: fall back to the creator the row carries (`created_by`,
    // as `is_owner` does). With an initiator, its id decides.
    const id = initiator?.id ?? session.created_by ?? null;
    const isViewer = Boolean(viewerId) && id === viewerId && (initiator?.id != null || session.is_owner !== false);
    return { type: 'member', id, isViewer, label: initiator?.label || null };
  }
  return { type: initiator.type, id: initiator.id, isViewer: false, label: initiator.label || null };
}
