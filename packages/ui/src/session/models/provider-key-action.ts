import type { GatewayErrorDetails } from '@kortix/sdk';

/**
 * Gateway codes a person fixes on the provider's account in Models: no key,
 * a key the provider refused, an expired provider login, a provider account
 * with no funds (`providerClientErrorBody`, `resolve-candidates.ts`).
 */
const FIXED_IN_MODELS = new Set([
  'provider_not_connected',
  'provider_key_rejected',
  'provider_reauth_required',
  'provider_payment_required',
]);

/** Providers with their own fix: ChatGPT (`chatGptConnectionAction`) and Claude (`claudeConnectionAction`). */
const OWN_FIX = new Set(['codex', 'openai-codex', 'claude-agent']);

/** The provider a gateway model id names (`anthropic/claude-x` → `anthropic`), without OpenCode's `kortix/`. */
function providerOfModel(model: string | undefined): string | undefined {
  const id = (model ?? '').replace(/^kortix\//, '');
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : undefined;
}

/**
 * The provider whose key a failed turn needs fixed in Models → Providers, or
 * null. A resolution error names no provider (`provider: ''`), so the routed
 * model names it. A Kortix-managed model (no provider prefix) never needs a key.
 */
export function providerKeyFix(
  details: Pick<GatewayErrorDetails, 'code' | 'provider' | 'requestedModel' | 'resolvedModel' | 'upstreamStatus'> | null | undefined,
): { providerId: string; code: string } | null {
  if (!details) return null;
  const code = details.code ?? (details.upstreamStatus === 401 || details.upstreamStatus === 403 ? 'provider_key_rejected' : undefined);
  if (!code || !FIXED_IN_MODELS.has(code)) return null;
  const providerId = details.provider || providerOfModel(details.resolvedModel ?? details.requestedModel);
  if (!providerId || OWN_FIX.has(providerId) || providerId === 'kortix') return null;
  return { providerId, code };
}
