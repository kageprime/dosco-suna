/**
 * A turn on a Claude subscription model needs a Claude account the LLM gateway
 * will use for it: the session's selected accounts, the personal-key owner's
 * own account, or one shared with the project (`claude-subscription/accounts.ts`).
 * Without one, the turn is refused before it reaches the box, with a code the
 * clients turn into a Connect button and a message that says why: no account,
 * or the connected ones rest, need reconnection, or Anthropic forbids them.
 */
import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE, isClaudeAgentModelRef, type ClaudeSubscriptionMissing } from '../../llm-gateway/resolution/claude-agent';
import { claudeCredentialProblem } from '../../claude-subscription/accounts';
import { resolveSessionPersonalOwner } from '../lib/personal-resources';

export { CLAUDE_SUBSCRIPTION_REQUIRED, CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE, claudeSubscriptionRequiredBody, type ClaudeSubscriptionMissing } from '../../llm-gateway/resolution/claude-agent';

/** A prompt body's model as a ref: `{providerID, modelID}` or a plain string. */
export function promptModelRef(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (!raw || typeof raw !== 'object') return null;
  const model = raw as { providerID?: unknown; modelID?: unknown };
  if (typeof model.providerID !== 'string' || typeof model.modelID !== 'string') return null;
  return `${model.providerID}/${model.modelID}`;
}

/** The model a session runs when a prompt names none (`metadata.model`). */
export async function sessionModelPin(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.model === 'string' ? metadata.model : null;
}

/**
 * The model ref that makes this turn need a Claude account it cannot use, and
 * why, or null when the turn may go on. `model` is the turn's model: the
 * prompt's, else the session's. `sessionId` absent: a new session private to `userId`.
 */
export async function missingClaudeSubscription(input: {
  accountId: string;
  projectId: string;
  sessionId?: string | null;
  userId: string | null;
  model: string | null;
}): Promise<ClaudeSubscriptionMissing | null> {
  if (!input.model || !isClaudeAgentModelRef(input.model)) return null;
  if (!input.userId) return { model: input.model, message: CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE };
  const personalUserId = input.sessionId
    ? await resolveSessionPersonalOwner({ projectId: input.projectId, sessionId: input.sessionId, legacyUserId: input.userId, accountId: input.accountId })
    : input.userId;
  const problem = await claudeCredentialProblem({
    accountId: input.accountId, projectId: input.projectId, userId: input.userId,
    sessionId: input.sessionId ?? null, personalUserId,
  });
  if (!problem) return null;
  // The reason names accounts and Anthropic's words. Only the caller's own accounts
  // (`personalUserId` is the caller) or accounts shared with everyone (null) may be
  // named: a Space-shared private session still resolves its creator's private
  // accounts until a turn binds the prompter, and those are not the caller's to see.
  const nameable = personalUserId === null || personalUserId === input.userId;
  const message = problem.code === 'provider_not_connected' || !nameable
    ? CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE
    : `${problem.message} ${problem.suggestion}`;
  return { model: input.model, message };
}
