import { describe, expect, test } from 'bun:test';
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
  antigravityModelId,
  isAntigravityModelRef,
} from '../antigravity';

describe('Google Antigravity api-contract', () => {
  test('constants are correctly configured', () => {
    expect(ANTIGRAVITY_PROVIDER_ID).toBe('antigravity');
    expect(ANTIGRAVITY_PROVIDER_NAME).toBe('Google Antigravity');
    expect(ANTIGRAVITY_DEFAULT_MODEL).toBe('gemini-3.8-flash');
    expect(ANTIGRAVITY_EFFORTS).toEqual(['low', 'medium', 'high']);
  });

  test('models catalog contains verified models and properties', () => {
    expect(ANTIGRAVITY_MODELS.length).toBe(6);

    const argon = ANTIGRAVITY_MODELS.find((m) => m.id === 'gemini-4-argon');
    expect(argon).toBeDefined();
    expect(argon?.badge).toBe('new');
    expect(argon?.defaultEffort).toBe('medium');

    const flash = ANTIGRAVITY_MODELS.find((m) => m.id === 'gemini-3.8-flash');
    expect(flash).toBeDefined();
    expect(flash?.defaultEffort).toBe('high');

    const opus = ANTIGRAVITY_MODELS.find((m) => m.id === 'claude-opus-5.5');
    expect(opus).toBeDefined();
    expect(opus?.badge).toBe('new');

    const sonnet = ANTIGRAVITY_MODELS.find((m) => m.id === 'claude-sonnet-5.5');
    expect(sonnet).toBeDefined();
    expect(sonnet?.badge).toBe('new');

    const gptOss = ANTIGRAVITY_MODELS.find((m) => m.id === 'gpt-oss-120b');
    expect(gptOss).toBeDefined();
    expect(gptOss?.badge).toBe('notice');

    const carbon = ANTIGRAVITY_MODELS.find((m) => m.id === 'gemini-4-carbon');
    expect(carbon).toBeDefined();
    expect(carbon?.unavailable).toBe(true);
    expect(carbon?.badge).toBe('unavailable');
  });

  test('antigravityModelId and isAntigravityModelRef resolve references correctly', () => {
    expect(isAntigravityModelRef('antigravity/gemini-3.8-flash')).toBe(true);
    expect(antigravityModelId('antigravity/gemini-3.8-flash')).toBe('gemini-3.8-flash');

    expect(isAntigravityModelRef('claude-agent/opus')).toBe(false);
    expect(antigravityModelId('claude-agent/opus')).toBeNull();

    expect(isAntigravityModelRef('codex/gpt-5')).toBe(false);
    expect(antigravityModelId('codex/gpt-5')).toBeNull();

    expect(isAntigravityModelRef(null)).toBe(false);
    expect(antigravityModelId(null)).toBeNull();
  });

  test('parseAntigravityAuth parses tokens, oauth_creds.json and wrapped structures', async () => {
    const { parseAntigravityAuth } = await import('../antigravity');

    // 1. Raw bearer token
    const raw = parseAntigravityAuth('ya29.a0AfH6SMB...test');
    expect(raw).not.toBeNull();
    expect(raw?.type).toBe('bearer');
    expect(raw?.access).toBe('ya29.a0AfH6SMB...test');

    // 2. Gemini API key
    const apiKey = parseAntigravityAuth('AIzaSyD-xyz123');
    expect(apiKey).not.toBeNull();
    expect(apiKey?.access).toBe('AIzaSyD-xyz123');

    // 3. Local Google oauth_creds.json format
    const googleCreds = JSON.stringify({
      access_token: 'ya29.google-test-token',
      refresh_token: '1//refresh-test-token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      token_type: 'Bearer',
      expiry_date: 1731330000000,
    });
    const parsedGoogle = parseAntigravityAuth(googleCreds);
    expect(parsedGoogle).not.toBeNull();
    expect(parsedGoogle?.access).toBe('ya29.google-test-token');
    expect(parsedGoogle?.refresh).toBe('1//refresh-test-token');
    expect(parsedGoogle?.expires).toBe(1731330000000);

    // 4. Wrapped Antigravity JSON
    const wrapped = JSON.stringify({
      antigravity: {
        access: 'ya29.wrapped-token',
        refresh: '1//wrapped-refresh',
        expires: 1731340000000,
        email: 'user@example.com',
      },
    });
    const parsedWrapped = parseAntigravityAuth(wrapped);
    expect(parsedWrapped).not.toBeNull();
    expect(parsedWrapped?.access).toBe('ya29.wrapped-token');
    expect(parsedWrapped?.email).toBe('user@example.com');
  });
});
