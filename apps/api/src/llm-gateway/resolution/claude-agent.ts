/**
 * Model refs of the `claude-agent` provider: Claude models on the session
 * person's own Claude subscription (`@kortix/api-contract/claude-agent`).
 *
 * Claude Code in the box makes these model calls straight to Anthropic. The
 * LLM gateway never serves them, so they skip its servability probe, its
 * credit admission and the managed-model lineup. A ref is `claude-agent/<id>`
 * and is stored and booted as-is (`KORTIX_MODEL=claude-agent/<id>`).
 */
import {
  CLAUDE_AGENT_MODELS,
  CLAUDE_AGENT_PROVIDER_ID,
  claudeAgentModelId,
} from '@kortix/api-contract/claude-agent';

export { isClaudeAgentModelRef } from '@kortix/api-contract/claude-agent';

export type ClaudeAgentRefCheck =
  | { kind: 'none' }
  | { kind: 'valid'; ref: string }
  | { kind: 'invalid'; message: string };

const VALID_REFS = CLAUDE_AGENT_MODELS.map((model) => `${CLAUDE_AGENT_PROVIDER_ID}/${model.id}`);

/** `none`: another provider's ref. `invalid`: a `claude-agent/` ref with an unknown id. */
export function checkClaudeAgentRef(ref: string | null | undefined): ClaudeAgentRefCheck {
  const trimmed = (ref ?? '').trim();
  if (!trimmed.startsWith(`${CLAUDE_AGENT_PROVIDER_ID}/`)) return { kind: 'none' };
  const id = claudeAgentModelId(trimmed);
  if (id && CLAUDE_AGENT_MODELS.some((model) => model.id === id)) return { kind: 'valid', ref: `${CLAUDE_AGENT_PROVIDER_ID}/${id}` };
  return {
    kind: 'invalid',
    message: `"${trimmed}" is not a Claude subscription model. Use one of: ${VALID_REFS.join(', ')}.`,
  };
}

export const CLAUDE_SUBSCRIPTION_REQUIRED = 'claude_subscription_required' as const;
export const CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE = 'Connect your Claude subscription to use Claude models.';

/** A turn's Claude subscription model that has no Claude account to run on, and why. */
export interface ClaudeSubscriptionMissing {
  model: string;
  /**
   * Why: `CLAUDE_SUBSCRIPTION_REQUIRED_MESSAGE` when no account is connected,
   * else the reason the connected accounts cannot serve (resting at a usage
   * limit, refused, forbidden by Anthropic) with its fix.
   */
  message: string;
}

/**
 * The 409 body of a turn on a Claude subscription model with no Claude account
 * to run on. `code` is what a client branches on (a Connect button); `message`
 * says why, naming the accounts when some are connected.
 */
export function claudeSubscriptionRequiredBody(missing: ClaudeSubscriptionMissing) {
  return {
    error: missing.message,
    message: missing.message,
    code: CLAUDE_SUBSCRIPTION_REQUIRED,
    provider_id: CLAUDE_AGENT_PROVIDER_ID,
    model: missing.model,
  };
}
