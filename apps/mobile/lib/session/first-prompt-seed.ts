/**
 * first-prompt-seed — the project-home send's first prompt, written into the
 * session store as an optimistic user message before the thread mounts
 * (COR-185).
 *
 * Without it, `SessionPage` mounts on an empty transcript: the loading page's
 * bubble disappears, the fresh-session hero shows, and the bubble comes back
 * only when the server echo lands. With it, the thread's first frame already
 * holds the prompt and a busy row.
 *
 * The server already holds this prompt (`initial_prompt` or
 * `pending_prompt`), so the seed never gets "Try again": a client re-send
 * would send it twice. The echo replaces the seed through the SDK store's
 * ordinary optimistic swap. Pure, so `bun test` runs it.
 */
import type { SessionLogMessage } from '@kortix/sdk';
import type { AttachedFile } from './attachments';
import { optimisticUserParts } from './optimistic-parts';
import { parseUserMessageBlocks, parseUserMessageText } from './user-message';
import type { OptimisticMessage } from './session-store';
import { mintWireMessageId } from './wire-message-id';

/**
 * How long the seeded busy row may wait for a sign of the prompt (the real
 * user message or any reply) before it clears. The seed itself stays.
 */
export const SEED_BUSY_WATCHDOG_MS = 30_000;

export function firstPromptSeed(i: {
  text: string;
  files: AttachedFile[];
  /** The runtime's root session id the thread and the live stream use — never the Kortix `session_id`. */
  runtimeSessionId: string;
  /** Ids the store already holds for this root. Any id means no seed. */
  knownMessageIds: string[];
  nowMs: number;
}): OptimisticMessage | null {
  const text = i.text.trim();
  if (!text && i.files.length === 0) return null;
  // The store already holds this root (a reopen, or the echo won the race).
  if (i.knownMessageIds.length > 0) return null;

  const parts = optimisticUserParts(text, i.files, i.nowMs);

  // A stub: the server's echo carries the full message (agent, model).
  return {
    info: {
      id: mintWireMessageId({ nowMs: i.nowMs, knownMessageIds: i.knownMessageIds }),
      role: 'user',
      sessionID: i.runtimeSessionId,
      time: { created: i.nowMs },
    },
    parts,
  };
}

/**
 * True while nothing but the seed is in the transcript: no real user message
 * and no reply yet. `messageIds` are the ids the store holds; none counts as
 * undelivered.
 */
export function seedUndelivered(messageIds: readonly string[], seedId: string): boolean {
  return messageIds.every((id) => id === seedId);
}

/** The first prompt's seed, as the thread retires it. */
export interface SeededPrompt {
  id: string;
  /** The prompt text as sent. Empty for a files-only prompt. */
  text: string;
}

type ThreadMessage = Pick<SessionLogMessage, 'message_id' | 'role' | 'kind' | 'blocks'>;

/**
 * `text` as the session log stores it, trimmed: the server replaces a NUL and
 * each lone UTF-16 surrogate with U+FFFD before it writes the log
 * (apps/api `session-log-ingest.ts`).
 */
export function logText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) out += '\uFFFD';
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) out += text[i] + text[++i];
      else out += '\uFFFD';
    } else if (c >= 0xdc00 && c <= 0xdfff) out += '\uFFFD';
    else out += text[i];
  }
  return out.trim();
}

/**
 * True when the thread holds the seed's echo: a user turn, not the seed and
 * not another optimistic send from this device, whose bubble text equals the
 * seed's. Both sides are parsed as the bubble shows them (the runtime adds
 * `<file>` tags for uploads) and normalized as the log stores them. A
 * files-only seed matches a turn with files and no text. The equality keeps a follow-up
 * queued before the echo from retiring the seed.
 *
 * On the session log (v2) the echo arrives as a `log.*` put under the id the
 * server minted, and no v1 `message.updated` frame retires the seed. The seed
 * id is never sent to the server, so the log cannot name it either: without
 * this check the seed stays and renders as a second copy of the first prompt.
 */
export function seedEchoed(
  messages: readonly ThreadMessage[] | undefined,
  seed: SeededPrompt,
  isOptimistic: (messageId: string) => boolean
): boolean {
  const want = logText(parseUserMessageText(seed.text).text);
  return (messages ?? []).some((m) => {
    if (m.role !== 'user' || m.kind !== 'turn' || m.message_id === seed.id || isOptimistic(m.message_id)) return false;
    const parsed = parseUserMessageBlocks(m.blocks);
    // A files-only seed needs its files: a synthetic turn parses to no text too.
    if (!want && parsed.attachments.length === 0) return false;
    return logText(parsed.content.text) === want;
  });
}

/** The seed of each runtime root whose echo has not landed yet. */
const seededPrompts = new Map<string, SeededPrompt>();

export function rememberSeededPrompt(runtimeSessionId: string, seed: SeededPrompt): void {
  seededPrompts.set(runtimeSessionId, seed);
}

export function seededPromptOf(runtimeSessionId: string): SeededPrompt | undefined {
  return seededPrompts.get(runtimeSessionId);
}

export function forgetSeededPrompt(runtimeSessionId: string): void {
  seededPrompts.delete(runtimeSessionId);
}
