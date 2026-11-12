import type { ProjectSession, ProjectSessionInitiatorType } from '@kortix/sdk';
import { classifySessionStarter } from '@kortix/shared/session/session-starter';

/**
 * Who started the RUN a session belongs to. The classification lives once in
 * `@kortix/shared/session/session-starter` (the server-derived `initiator`:
 * member/trigger/channel/api/system, "You" only when the starter is the
 * viewer); this host derives the row's wording from it — `labels.you`, the
 * member's name with the owner fallbacks, `labels.unknown` when nothing names
 * the starter.
 */
export interface SessionStarter {
  type: ProjectSessionInitiatorType;
  /** Display label. "You" only when the initiator is the viewer. */
  label: string;
  isViewer: boolean;
  /** trigger slug, channel id, or service-account id — for tooltips and icons. */
  id: string | null;
}

export function sessionStarter(
  session: Pick<
    ProjectSession,
    'initiator' | 'is_owner' | 'owner_name' | 'owner_email' | 'created_by'
  >,
  viewerId: string | null,
  labels: { you: string; unknown: string },
): SessionStarter {
  const core = classifySessionStarter(session, viewerId);
  if (core.type === 'member') {
    return {
      ...core,
      label: core.isViewer ? labels.you : core.label ?? session.owner_name ?? session.owner_email ?? labels.unknown,
    };
  }
  return { ...core, label: core.label || core.id || labels.unknown };
}
