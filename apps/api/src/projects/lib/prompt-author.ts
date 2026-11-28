/**
 * Who wrote a prompt, for the model (KRTX-5121). Several people can write in
 * one shared session, and a prompt's text does not say who wrote it: the model
 * took every message for the words of the person who started the session.
 * The delivery names the person on the runtime prompt body (`author`), and
 * kortixd puts the name above the message for the model only.
 *
 * Kept off `session-message-authors.ts` on purpose: that module reads agents
 * and git, and these two run on every prompt delivery.
 */
import { memberDisplayName } from './project-space-members';
import { resolveUserIdentities } from './user-identity';

/**
 * The person who wrote an inbox row's prompt, by the rule
 * `sessionMessageAuthors` attributes messages with: a row of the prompt route
 * (`clientMessageId`) is its authenticated sender's, unless an agent session
 * sent it (`authorSessionId`). Null for every other row: a trigger, a channel
 * relay or a platform notice names its source in its own text.
 */
export function inboxPromptPersonId(row: { actorUserId: string | null; payload: unknown }): string | null {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.clientMessageId !== 'string' || typeof payload.authorSessionId === 'string') return null;
  return row.actorUserId ?? null;
}

/**
 * The name the model reads above a person's prompt: the display name, else
 * the part of the email before `@` (`memberDisplayName`, as `Started by` in the
 * turn's "Where you are"). Null for no person, an unknown user, or a failed
 * read: the prompt then goes without a name, as before.
 */
export async function promptAuthorName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const identity = (await resolveUserIdentities([userId])).get(userId);
    if (!identity?.exists) return null;
    return memberDisplayName({ displayName: identity.displayName, email: identity.email }) || null;
  } catch {
    return null;
  }
}
