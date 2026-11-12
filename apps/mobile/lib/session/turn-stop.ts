/**
 * Who may stop a running turn, and who stopped one. Pure, so the rules have a
 * test.
 *
 * In a shared session only the member who prompted the running turn, the
 * session owner or a project manager may stop it. The server owns the rule:
 * `GET .../turn` answers `can_stop` (`useSession().canStop`), a refused stop
 * answers 403 `not_turn_prompter`, and the message authors carry `stops`, the
 * member who stopped each turn, keyed by the user message that started it.
 * Same rules as web.
 *
 * No React / React Native import.
 */
import type { SessionMessageAuthors } from '@kortix/sdk';

import { participantName } from './participants';

/**
 * The stop-refusal guard lives once in `@kortix/shared/session/stop-refusal`;
 * both hosts re-export it.
 */
export { NOT_TURN_PROMPTER, stopRefusalMessage } from '@kortix/shared/session/stop-refusal';

/**
 * May the viewer stop the running turn? The server's `can_stop`, read through
 * `useSession().canStop`. No answer (no bound runtime, or an SDK without the
 * field) reads as yes: the server still refuses a stop it does not allow.
 */
export function viewerMayStop(runtime: { isBusy: boolean; canStop?: boolean } | null | undefined): boolean {
  return runtime?.canStop !== false;
}

/**
 * The name of the member who stopped a turn, when that member is not the
 * viewer; else null. The viewer's own stop stays silent, as on web. An unknown
 * viewer is no guess: null. `messageId` is the user message that started the
 * turn.
 */
export function turnStoppedBy(
  authors: SessionMessageAuthors | undefined,
  viewerId: string | null | undefined,
  messageId: string,
): string | null {
  const stopper = authors?.stops?.[messageId];
  if (stopper?.kind !== 'member' || !viewerId || stopper.user_id === viewerId) return null;
  return participantName(stopper) || null;
}
