/**
 * Failed sends (COR-143): a thread message whose prompt never reached the
 * runtime. The optimistic user message stays in the thread, dimmed, with
 * "Not sent · Try again"; this store keeps what a retry sends again. Web keeps
 * a failed accepted send on screen the same way (`uploadStatus` on
 * `apps/web/src/features/session/turn/user-message.tsx`).
 *
 * In memory only: the payload is the text as sent, the send options, and —
 * once a message could carry attachments (COR-185) — the prompt's file parts
 * (`fileParts`, `lib/session/prompt-parts.ts`) plus the picked files
 * (`localFiles`) that made them, so a retry re-posts the same upload handles
 * through `createSessionPrompt` rather than re-uploading. An unbound upload
 * lives 24 h on the server (`packages/sdk/src/core/attachments/
 * prompt-attachments.ts`), so a retry inside that window still finds it.
 */

import { create } from 'zustand';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLogMessage, type SessionLogThread, type SessionPromptPart } from '@kortix/sdk';
import type { AttachedFile } from './attachments';
import { optimisticUserParts } from './optimistic-parts';

export interface FailedSend<TOptions = unknown, TMentions = unknown> {
  /** The text `handleSend` was called with (attachment refs included). */
  text: string;
  options: TOptions;
  mentions?: TMentions;
  /** The uploaded file parts a retry re-posts as-is. */
  fileParts?: SessionPromptPart[];
  /** The picked files behind `fileParts`, for the composer's tiles on retry. */
  localFiles?: AttachedFile[];
  /**
   * The ids the failed attempt sent. A retry sends the same ids: the prompt
   * inbox dedupes on `clientMessageId`, so an attempt that reached the server
   * before its response was lost does not run the prompt twice.
   */
  clientMessageId?: string;
  messageId?: string;
  /** When the send failed: where the bubble sorts in the thread. */
  failedAtMs?: number;
}

export interface SendIds {
  clientMessageId: string;
  messageId: string;
}

/** The ids of one send: a retry's kept ids, each missing one minted fresh. */
export function sendIdsFor(retry: Partial<SendIds> | undefined, mint: () => SendIds): SendIds {
  if (retry?.clientMessageId && retry.messageId) {
    return { clientMessageId: retry.clientMessageId, messageId: retry.messageId };
  }
  const fresh = mint();
  return {
    clientMessageId: retry?.clientMessageId ?? fresh.clientMessageId,
    messageId: retry?.messageId ?? fresh.messageId,
  };
}

type BySession = Record<string, Record<string, FailedSend>>;

interface FailedSendState {
  /** session id → optimistic message id → payload */
  bySession: BySession;
  markFailed: (sessionId: string, messageId: string, send: FailedSend) => void;
  /** Removes and returns the payload; undefined when absent (a double tap). */
  take: (sessionId: string, messageId: string) => FailedSend | undefined;
}

export function withFailed(state: BySession, sessionId: string, messageId: string, send: FailedSend): BySession {
  return { ...state, [sessionId]: { ...state[sessionId], [messageId]: send } };
}

export function withoutFailed(state: BySession, sessionId: string, messageId: string): BySession {
  const session = state[sessionId];
  if (!session || !(messageId in session)) return state;
  const nextSession = { ...session };
  delete nextSession[messageId];
  const next = { ...state };
  if (Object.keys(nextSession).length > 0) next[sessionId] = nextSession;
  else delete next[sessionId];
  return next;
}

export const useFailedSendStore = create<FailedSendState>((set, get) => ({
  bySession: {},
  markFailed: (sessionId, messageId, send) =>
    set((state) => ({ bySession: withFailed(state.bySession, sessionId, messageId, send) })),
  take: (sessionId, messageId) => {
    const send = get().bySession[sessionId]?.[messageId];
    if (!send) return undefined;
    set((state) => ({ bySession: withoutFailed(state.bySession, sessionId, messageId) }));
    return send;
  },
}));

const EMPTY: Record<string, FailedSend> = {};

/** The failed sends of one session, by message id. Stable when empty. */
export function useFailedSends(sessionId: string): Record<string, FailedSend> {
  return useFailedSendStore((state) => state.bySession[sessionId] ?? EMPTY);
}

/**
 * The failed sends of a session as user messages of its thread
 * (`SessionLogMessage`), oldest first. A failed send is not in the transcript
 * (the server never had it), so `threadWithFailedSends` places these among the
 * messages it read: the message stays where the user sent it, dimmed, with
 * "Not sent · Try again". Each picked file is an attachment block with its
 * device URI (`localUriOf`).
 */
export function failedSendMessages(threadId: string, failed: Record<string, FailedSend>): SessionLogMessage[] {
  return Object.entries(failed)
    .sort(([, a], [, b]) => (a.failedAtMs ?? 0) - (b.failedAtMs ?? 0))
    .map(([messageId, send]): SessionLogMessage => {
      const createdAt = send.failedAtMs ?? 0;
      return {
        schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: messageId, thread_id: threadId,
        seq: Number.MAX_SAFE_INTEGER, role: 'user', kind: 'turn', status: 'complete', in_context: true, origin: 'prompt',
        model: null, usage: null, finish: null, error: null, created_at: new Date(createdAt).toISOString(), completed_at: null,
        producer: { harness: 'kortix-mobile', harness_version: '', adapter_version: '1' },
        blocks: optimisticUserParts(send.text, send.localFiles ?? [], createdAt).map((part) =>
          part.type === 'text'
            ? { type: 'text', id: part.id, text: part.text }
            : { type: 'attachment', id: part.id, mime: part.mime, name: part.filename },
        ),
      };
    });
}

/**
 * `thread` with its failed sends, each where the user sent it: before the thread's first
 * prompt sent after it (`created_at` against `failedAtMs`), else last. Never between a prompt
 * and its replies, so a copy takes no reply. A copy takes the `seq` of the message before it,
 * so the thread's `seq` never falls. The same thread object when there is no failed send.
 *
 * It used to append every copy after the whole thread (`seq` = `Number.MAX_SAFE_INTEGER`): a
 * "Not sent" message stayed under every later turn, as a stale message at the bottom.
 */
export function threadWithFailedSends(thread: SessionLogThread, failed: Record<string, FailedSend>): SessionLogThread {
  const copies = failedSendMessages(thread.thread_id, failed);
  if (copies.length === 0) return thread;
  const messages = [...thread.messages];
  for (const copy of copies) {
    const sentAt = Date.parse(copy.created_at);
    let at = messages.findIndex(
      (m) => m.role === 'user' && m.kind !== 'context' && Date.parse(m.created_at) > sentAt,
    );
    if (at < 0) at = messages.length;
    messages.splice(at, 0, { ...copy, seq: messages[at - 1]?.seq ?? 0 });
  }
  return { ...thread, messages };
}

/** Every id under which the server holds a prompt: what proves a send reached it. */
export interface ServerHeldSendIds {
  messageIds: ReadonlySet<string>;
  clientMessageIds: ReadonlySet<string>;
}

/**
 * The ids the server holds a prompt under: the session log's messages, the prompt inbox's rows
 * (queued, on the wire, or failed on the server, which "Up next" shows) and its `sent` list
 * (accepted, not in the log yet). A re-minted prompt is listed under its wire id too.
 */
export function serverHeldSendIds(input: {
  messages?: readonly Pick<SessionLogMessage, 'message_id'>[];
  prompts?: readonly { client_message_id?: string | null; message_id?: string | null; wire_message_id?: string | null }[];
  sent?: readonly { message_id?: string | null; wire_message_id?: string | null }[];
}): ServerHeldSendIds {
  const messageIds = new Set<string>();
  const clientMessageIds = new Set<string>();
  for (const m of input.messages ?? []) messageIds.add(m.message_id);
  for (const p of [...(input.prompts ?? []), ...(input.sent ?? [])]) {
    if (p.message_id) messageIds.add(p.message_id);
    if (p.wire_message_id) messageIds.add(p.wire_message_id);
  }
  for (const p of input.prompts ?? []) if (p.client_message_id) clientMessageIds.add(p.client_message_id);
  return { messageIds, clientMessageIds };
}

/**
 * The failed sends the server does not hold. A send whose request reached the server and whose
 * answer was lost (a timeout, a dropped connection) threw on the device and was marked failed:
 * the server delivered it, so it is not "Not sent". The same object when every send is unsent.
 */
export function unsentFailedSends(failed: Record<string, FailedSend>, held: ServerHeldSendIds): Record<string, FailedSend> {
  const unsent = Object.entries(failed).filter(
    ([messageId, send]) =>
      !held.messageIds.has(messageId) &&
      !(send.messageId && held.messageIds.has(send.messageId)) &&
      !(send.clientMessageId && held.clientMessageIds.has(send.clientMessageId)),
  );
  return unsent.length === Object.keys(failed).length ? failed : Object.fromEntries(unsent);
}
