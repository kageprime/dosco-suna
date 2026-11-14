import type { AttachedFile } from './session-chat-input';

/**
 * What a composer does to itself on send.
 *
 *  - `true` — every in-thread composer. It stays mounted, so it resets in
 *    place and revokes the local object URLs nobody references any more.
 *  - `'text-only'` — a space composer (`space-view.tsx`). It clears like any
 *    other composer, so the message visibly LEAVES the box, but it revokes
 *    nothing: the same local URLs are what the new thread draws its
 *    attachment previews from a moment later.
 *  - `false` — a composer that must keep the submitted draft on screen
 *    untouched. Nothing clears and nothing is revoked. Project home is one:
 *    the sent message stays in the locked box under the spinner until the
 *    session page opens, so the user sees what is being sent and a refused
 *    send leaves the text in place.
 */
export type ComposerSendReset = boolean | 'text-only';

/**
 * On send, decide whether the composer resets in place and which local object
 * URLs to revoke.
 *
 * Extracted from `SessionChatInput.handleSubmit` so the decision — and, crucially,
 * *which* URLs get revoked — is unit-testable without a DOM harness.
 */
export function resolveComposerResetOnSend(
  clearOnSend: ComposerSendReset,
  attachedFiles: readonly AttachedFile[],
): { clear: boolean; urlsToRevoke: string[] } {
  if (!clearOnSend) return { clear: false, urlsToRevoke: [] };
  // Cleared, but the bytes behind these URLs are about to be drawn by another
  // surface. Revoking them here is what broke the instant shell's previews.
  if (clearOnSend === 'text-only') return { clear: true, urlsToRevoke: [] };
  return {
    clear: true,
    urlsToRevoke: attachedFiles
      .filter((f): f is Extract<AttachedFile, { kind: 'local' }> => f.kind === 'local')
      .map((f) => f.localUrl),
  };
}
