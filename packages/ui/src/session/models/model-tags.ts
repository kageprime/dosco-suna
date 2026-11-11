import type { FlatModel } from '@kortix/sdk/react';

const FREE_TOKEN = /(^|[\s/_-])free($|[\s/_-])/i;

export function shouldShowFreeTag(
  model: Pick<FlatModel, 'free' | 'modelID' | 'modelName'>,
): boolean {
  if (model.free === true) return true;
  return FREE_TOKEN.test(model.modelName) || FREE_TOKEN.test(model.modelID);
}

/**
 * The gateway's subscription route: a model billed to a connected ChatGPT
 * Plus/Pro account rather than metered per token. Wire ids are `codex/<model>`
 * and the explicit provider field is `codex`; both are checked because a stale
 * baked catalog can predate the field (same fallback `pickerGroupId` uses).
 */
export function isSubscriptionModel(
  model: Pick<FlatModel, 'modelID'> & { provider?: string | null },
): boolean {
  return model.provider === 'codex' || model.modelID.startsWith('codex/');
}

/**
 * A model that runs through Claude Code on the caller's own Claude Pro or Max
 * plan (`claude-agent/<id>`, `@kortix/api-contract/claude-agent`). It never
 * reaches the LLM gateway.
 */
export function isClaudeSubscriptionModel(model: { provider?: string | null; providerID?: string }): boolean {
  return model.providerID === 'claude-agent' || model.provider === 'claude-agent';
}

/**
 * A model that runs through Google Antigravity on the caller's own Google subscription
 * (`antigravity/<id>`, `@kortix/api-contract/antigravity`).
 */
export function isAntigravitySubscriptionModel(model: { provider?: string | null; providerID?: string }): boolean {
  return model.providerID === 'antigravity' || model.provider === 'antigravity';
}

/**
 * What the picker prints for a model.
 *
 * The gateway appends " (ChatGPT)" to every subscription model's name
 * (`picker-catalog.ts`, `catalog-models.ts`) so surfaces with no grouping —
 * the CLI, `/v1/models` — can still tell `gpt-6-astra` from
 * `codex/gpt-6-astra`. The picker HAS grouping: the rows already sit under a
 * "ChatGPT subscription" heading, so the suffix repeated the heading on every
 * row and pushed the real name off the same column as its managed twin.
 *
 * Display only. Search, aria labels and every stored id keep the full name, so
 * typing "chatgpt" still finds these rows.
 */
export function pickerModelName(
  model: Pick<FlatModel, 'modelID' | 'modelName'> & { provider?: string | null },
): string {
  if (!isSubscriptionModel(model)) return model.modelName;
  // No leading `\s*`: `.trim()` drops those spaces, and `\s*\(` backtracks
  // quadratically on a long space run (CodeQL js/polynomial-redos).
  return model.modelName.replace(/\(ChatGPT\)\s*$/, '').trim() || model.modelName;
}

/**
 * Detects whether a model is served via OpenCode or OpenRouter to provide
 * clear visual differentiation in the model selector.
 */
export function modelSourceBadge(
  model: Pick<FlatModel, 'modelID' | 'modelName'> & {
    provider?: string | null;
    providerID?: string | null;
    upstreamProvider?: string | null;
    upstream_provider?: string | null;
  },
): 'OpenCode' | 'OpenRouter' | null {
  const p = (model.provider || model.providerID || '').toLowerCase();
  const id = (model.modelID || '').toLowerCase();
  const name = (model.modelName || '').toLowerCase();
  const upstream = (model.upstreamProvider || model.upstream_provider || '').toLowerCase();

  if (
    upstream === 'opencode' ||
    p === 'opencode' ||
    p === 'opencode-go' ||
    id.startsWith('opencode/') ||
    id.startsWith('opencode-go/') ||
    id === 'big-pickle' ||
    name.includes('opencode')
  ) {
    return 'OpenCode';
  }

  if (
    upstream === 'openrouter' ||
    p === 'openrouter' ||
    id.startsWith('openrouter/') ||
    name.includes('openrouter')
  ) {
    return 'OpenRouter';
  }

  return null;
}
