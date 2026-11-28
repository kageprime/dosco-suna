/**
 * Queue undo — Clear and remove act at once and offer Undo in a toast.
 *
 * `restoreQueued` puts the removed messages back where they were in the
 * snapshot taken before the removal, and keeps whatever changed since: a
 * message queued afterwards stays (at the end), a message sent afterwards is
 * not brought back.
 */

import { STALE_RUNTIME_DELIVERY_ERROR, splitPastedContent } from '@kortix/shared';

interface QueuedLike {
  id: string;
}

export function restoreQueued<T extends QueuedLike>(
  current: readonly T[],
  snapshot: readonly T[],
  removedIds: readonly string[],
): T[] {
  const removed = new Set(removedIds);
  const currentIds = new Set(current.map((m) => m.id));
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const restored = snapshot.filter((m) => currentIds.has(m.id) || removed.has(m.id));
  const byId = new Map(current.map((m) => [m.id, m]));
  return [
    // Current objects win for messages still queued (they may have been edited).
    ...restored.map((m) => byId.get(m.id) ?? m),
    ...current.filter((m) => !snapshotIds.has(m.id)),
  ];
}

/** A queue row's line: the typed text without its pastes, or `Pasted text` for a pastes-only prompt (web `rowText`). */
export function queueRowText(text: string): string {
  const { text: typed, pastes } = splitPastedContent(text);
  return typed || (pastes.length > 0 ? 'Pasted text' : '');
}

export function queueHeaderLabel(count: number): string {
  return `Up next · ${count}`;
}

const STEER_FALLBACK_CAPTION = {
  unsupported: 'Waits for this turn. This session cannot take messages mid-turn.',
  not_prompter: 'Waits for this turn. Another member started it.',
  turn_ended: 'Runs as its own turn. The turn ended first.',
} as const;

/** The second line of a queue row: why a failed row was not sent, when a
 *  steered message is read, or why it waits instead. Null for a plain queued
 *  message. Copy matches web: a failed row reads "Not sent · <reason>", and a
 *  session that lost the API reads web's `queuedDisconnected` sentence. */
export function queueRowCaption(prompt: {
  state?: string;
  last_error?: string | null;
  delivery?: 'steer' | 'queue' | 'interrupt';
  steer_fallback?: keyof typeof STEER_FALLBACK_CAPTION | null;
}): string | null {
  if (prompt.state === 'failed') {
    const reason = prompt.last_error === STALE_RUNTIME_DELIVERY_ERROR ? DISCONNECTED_REASON : prompt.last_error;
    return reason ? `Not sent · ${reason}` : 'Not sent';
  }
  if (prompt.steer_fallback) return STEER_FALLBACK_CAPTION[prompt.steer_fallback];
  return prompt.delivery === 'steer' ? 'Read at next step' : null;
}

const DISCONNECTED_REASON = 'This session lost its connection to Kortix. Start a new session to continue.';

/** The queue row's action: "Try again" re-runs a row the server failed (the
 *  thread's "Not sent · Try again"), "Send now" sends a waiting one next. */
export function queueRowSendLabel(prompt: { state?: string }): string {
  return prompt.state === 'failed' ? 'Try again' : 'Send now';
}
