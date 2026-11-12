import { describe, expect, test } from 'bun:test';
import { providerKeyFix } from './provider-key-action';

describe('providerKeyFix', () => {
  test('a key the provider refused names its provider', () => {
    expect(providerKeyFix({ code: 'provider_key_rejected', provider: 'anthropic' })).toEqual({ providerId: 'anthropic', code: 'provider_key_rejected' });
    // A gateway older than the code: the upstream status says the same.
    expect(providerKeyFix({ provider: 'openai', upstreamStatus: 401 })).toEqual({ providerId: 'openai', code: 'provider_key_rejected' });
  });

  test('no key: a resolution error names no provider, the routed model does', () => {
    expect(providerKeyFix({ code: 'provider_not_connected', provider: '', resolvedModel: 'kortix/openrouter/google/gemini-3-pro' }))
      .toEqual({ providerId: 'openrouter', code: 'provider_not_connected' });
  });

  test('a provider account with no funds is fixed in Models too', () => {
    expect(providerKeyFix({ code: 'provider_payment_required', provider: 'openrouter' })?.providerId).toBe('openrouter');
  });

  test('ChatGPT, Claude, a managed model and an unrelated failure get no key fix', () => {
    expect(providerKeyFix({ code: 'provider_not_connected', provider: '', requestedModel: 'codex/gpt-6' })).toBeNull();
    expect(providerKeyFix({ code: 'provider_reauth_required', provider: 'claude-agent' })).toBeNull();
    expect(providerKeyFix({ code: 'provider_not_connected', provider: '', requestedModel: 'glm-5.3-flash' })).toBeNull();
    expect(providerKeyFix({ code: 'model_unavailable', provider: 'anthropic' })).toBeNull();
    expect(providerKeyFix(null)).toBeNull();
  });
});
