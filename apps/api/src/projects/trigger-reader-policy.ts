import { parseTriggerReaders } from '@kortix/manifest-schema';
import { isTriggerCreatedSessionMetadata } from '../connectors/share';

export type TriggerReaderPrincipal = { kind: 'human'; member: boolean } | { kind: 'agent'; name: string } | { kind: 'none' };

/** Additive standing applies only on an audited read path, never a mutation or runtime proxy. */
export function triggerReaderStanding(
  session: { metadata: unknown; spaceKind: string | null; tombstoned: boolean },
  principal: TriggerReaderPrincipal,
): boolean {
  if (session.tombstoned || session.spaceKind === 'dm' || !isTriggerCreatedSessionMetadata(session.metadata)) return false;
  if (!session.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata)) return false;
  const value = 'trigger_session_readers' in session.metadata ? session.metadata.trigger_session_readers : undefined;
  const parsed = parseTriggerReaders(value);
  if ('error' in parsed) return false;
  return principal.kind === 'human'
    ? principal.member && parsed.readers.humans === 'members'
    : principal.kind === 'agent' && parsed.readers.agents.includes(principal.name);
}
