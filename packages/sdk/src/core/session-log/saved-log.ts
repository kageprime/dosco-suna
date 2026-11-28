/**
 * How the device keeps a session's saved copy: the newest session-log page of its root thread
 * (`createSavedCopyStore`, key `<namespace>.log:<user>:<project>/<session>`). Every read
 * validates the page (`isSessionLogPage`). Internal: hosts call `createSavedCopyStore` and
 * `setSavedCopyStore`.
 */
import type { CopyCodec, StoredCopy } from '../session-sync/copy-store-types';
import { isSessionLogPage } from './guard';
import type { SessionLogPage } from './source';

/** A page worth painting: valid and not empty. */
const paintable = (page: SessionLogPage | null | undefined): page is SessionLogPage =>
  isSessionLogPage(page) && page.messages.length > 0;

/**
 * The copy within `maxChars`: whole, else its newest messages that fit with `has_more` set.
 * ponytail: re-serializes per dropped message (O(n²) on the 40-message first window); measure before a larger page.
 */
function fit(stored: StoredCopy<SessionLogPage>, maxChars: number): string | null {
  const { messages } = stored.e;
  for (let from = 0; from < messages.length; from++) {
    const text = JSON.stringify(from === 0 ? stored : { ...stored, e: { ...stored.e, messages: messages.slice(from), has_more: true } });
    if (text.length <= maxChars) return text;
  }
  return null;
}

export const SESSION_LOG_COPY: CopyCodec<SessionLogPage> = { paintable, fit, capturedAt: () => 0 };
