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
    expect(antigravityModelId(undefined)).toBeNull();
  });
});
