/**
 * Dependency-inverted hook: the box reaper settles a turn whose computer went
 * away (`runtime_gone`), and a background subagent's parent must hear about
 * it, or it waits for that child forever. The reaper's ledger
 * (projects/sandbox-turn-lifecycle.ts `clearSandboxTurn`) calls
 * `notifyTurnLost`; projects/subagent-notice.ts registers the relay, so the
 * lifecycle layer does not import the notice layer.
 *
 * Fire-and-forget: a relay failure never breaks the reaper.
 */
import { logger } from '../lib/logger';
import { createNotifier } from './notifier';

type TurnLostNotifier = (sessionId: string, turnToken: string) => unknown;

const notifier = createNotifier<[sessionId: string, turnToken: string]>((error, [sessionId]) =>
  logger.warn('[turn-lost-notifier] relay failed', {
    sessionId,
    error: error instanceof Error ? error.message : String(error),
  }),
);

/** Register a relay at startup. Registering the same function twice keeps one. Returns the remover. */
export function registerTurnLostNotifier(fn: TurnLostNotifier): () => void {
  return notifier.register(fn);
}

/** Tell every relay that `turnToken` of `sessionId` ended without its box. Never throws, never blocks. */
export function notifyTurnLost(sessionId: string, turnToken: string): void {
  notifier.notify(sessionId, turnToken);
}
