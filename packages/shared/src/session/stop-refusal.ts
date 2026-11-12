/**
 * The stop-refusal guard. Both hosts (`packages/ui/src/session/status/stop-refusal.ts`,
 * `apps/mobile/lib/session/turn-stop.ts`) re-export these, so every fix
 * lands once.
 */

/** The 403 `code` of a stop the server refused. */
export const NOT_TURN_PROMPTER = 'not_turn_prompter';

/**
 * The server's message when it refused a stop, else `fallback`; null for any
 * other failure, so the caller keeps its "Couldn't stop" toast. A REST stop
 * (the hold, "Stop and send") is an `ApiError` carrying the code. The runtime
 * abort answers through the sandbox proxy, whose error keeps the status and
 * the message but drops the body's `code`, so a 403 alone also counts.
 */
export function stopRefusalMessage(error: unknown, fallback?: string): string | null {
  if (!error || typeof error !== 'object') return null;
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  if (code !== NOT_TURN_PROMPTER && status !== 403) return null;
  const text = typeof message === 'string' ? message.trim() : '';
  return text || fallback || null;
}
