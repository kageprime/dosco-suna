/**
 * Who wrote a person's prompt (KRTX-5121). Several people can write in one
 * shared session, and a prompt's text does not say who wrote it: the model
 * read every message as the words of the person who started the session.
 *
 * apps/api names the person on the runtime prompt body (`author`, server-set:
 * its proxy drops a client's value). The model reads a `[From: "<name>"]`
 * line above the message (`modelPromptText`). People read their own words:
 * the wire part keeps `text`, and the session log keeps what the model read as
 * `model_text`, which a restore replays, so the attribution survives a new box.
 *
 * A prompt with no person behind it (a trigger, a channel relay, another
 * session, a platform notice) carries no `author` and goes as it is.
 */

export interface PromptAuthor {
  /** Display name, one line. */
  name: string
}

/** Longer names are cut: the line is context, not a place for prose. */
const MAX_AUTHOR_NAME_CHARS = 80

/** The `author` of a prompt body, or undefined. A malformed value is dropped, never a refusal. */
export function promptAuthorFrom(raw: unknown): PromptAuthor | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = (raw as { name?: unknown }).name
  if (typeof name !== 'string') return undefined
  const flat = name.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return { name: flat.length > MAX_AUTHOR_NAME_CHARS ? `${flat.slice(0, MAX_AUTHOR_NAME_CHARS - 1)}…` : flat }
}

/**
 * The text the model reads for a prompt: the author line, then the person's
 * words. The name is JSON-quoted, so it cannot close its quote or start a
 * line. Goes as it is without an author, for harness context (`synthetic`),
 * and for a `/` prompt: pi matches a command, a skill or a template at the
 * start of the text.
 */
export function modelPromptText(text: string, input: { author?: PromptAuthor; synthetic?: boolean }): string {
  if (!input.author || input.synthetic || text.startsWith('/')) return text
  return `[From: ${JSON.stringify(input.author.name)}]\n${text}`
}

/** The root's system prompt section that says what the author line means. */
export const PROMPT_AUTHOR_SECTION = [
  '## Who writes to you',
  'Several people can write in one session. A line `[From: "<name>"]` above a message names the person who wrote it.',
  'Answer the person who wrote the message. Never attribute one person\'s words, requests or preferences to another person.',
  'A message without that line does not name its writer.',
].join('\n')
