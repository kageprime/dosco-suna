import { describe, expect, test } from 'bun:test';

import {
  collectPreviewTargets,
  editablePolicySignature,
  fallbackModeForPolicy,
  hasAdvancedRoutingConfig,
  moveFallback,
  validateRoutingDraft,
} from '@kortix/ui/customize/sections/view/gateway/gateway-routing';

describe('gateway routing editor helpers', () => {
  test('reorders a finite fallback chain without mutating the input', () => {
    const source = ['primary-a', 'fallback-b', 'fallback-c'];
    expect(moveFallback(source, 2, -1)).toEqual(['primary-a', 'fallback-c', 'fallback-b']);
    expect(source).toEqual(['primary-a', 'fallback-b', 'fallback-c']);
    expect(moveFallback(source, 0, -1)).toEqual(source);
  });

  test('rejects duplicate models, self fallback, and missing override primaries', () => {
    expect(
      validateRoutingDraft({
        defaultModel: 'model-a',
        defaultFallback: { models: ['model-b', 'model-b'], fallbackOn: 'any-error' },
        rules: [],
      }),
    ).toContain('only appear once');
    expect(
      validateRoutingDraft({
        defaultModel: 'model-a',
        defaultFallback: { models: ['model-a'], fallbackOn: 'any-error' },
        rules: [],
      }),
    ).toContain('cannot include the primary');
    expect(
      validateRoutingDraft({
        defaultModel: null,
        defaultFallback: null,
        rules: [{ model: '', fallbackModels: [], fallbackOn: 'transient' }],
      }),
    ).toContain('primary model');
  });

  test('accepts inherited policy and bounded ordered rules', () => {
    expect(
      validateRoutingDraft({
        defaultModel: null,
        defaultFallback: null,
        rules: [
          {
            model: 'anthropic/claude-opus',
            fallbackModels: ['anthropic/claude-sonnet', 'glm-5.3-flash'],
            fallbackOn: 'transient',
          },
        ],
      }),
    ).toBeNull();
  });

  test('keeps custom and disabled fallback modes distinct', () => {
    expect(fallbackModeForPolicy(null)).toBe('inherit');
    expect(fallbackModeForPolicy({ models: [], fallbackOn: 'transient' })).toBe('disabled');
    expect(fallbackModeForPolicy({ models: ['glm-5.3-flash'], fallbackOn: 'any-error' })).toBe(
      'custom',
    );
    expect(
      validateRoutingDraft(
        {
          defaultModel: 'codex/gpt-5.6-sol',
          defaultFallback: { models: [], fallbackOn: 'any-error' },
          rules: [],
        },
        'custom',
      ),
    ).toContain('at least one');
  });

  test('collects a deduped preview target list across the primary, vision override, default chain, and rule chains', () => {
    expect(
      collectPreviewTargets(
        {
          visionModel: 'anthropic/claude-sonnet-4.6',
          defaultFallback: { models: ['glm-5.3-flash', 'auto'], fallbackOn: 'transient' },
          rules: [
            {
              model: 'codex/gpt-5.6-sol',
              fallbackModels: ['glm-5.3-flash'],
              fallbackOn: 'transient',
            },
          ],
        },
        'anthropic/claude-opus-4.8',
      ),
    ).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-4.6',
      'glm-5.3-flash',
      'codex/gpt-5.6-sol',
    ]);
  });

  test('preview targets skip null/auto entries and dedupe repeats', () => {
    expect(
      collectPreviewTargets({ visionModel: null, defaultFallback: null, rules: [] }, null),
    ).toEqual([]);
    expect(
      collectPreviewTargets(
        {
          visionModel: 'glm-5.3-flash',
          defaultFallback: { models: ['glm-5.3-flash'], fallbackOn: 'transient' },
          rules: [],
        },
        'glm-5.3-flash',
      ),
    ).toEqual(['glm-5.3-flash']);
  });

  test('an effective-default refetch does not overwrite an unsaved routing draft', () => {
    const policy = {
      defaultModel: 'codex/gpt-5.6-sol',
      visionModel: null,
      defaultFallback: { models: ['glm-5.3-flash'], fallbackOn: 'transient' as const },
      rules: [],
    };
    expect(editablePolicySignature({ ...policy, defaultModel: 'anthropic/claude-opus-4.8' })).toBe(
      editablePolicySignature(policy),
    );
    expect(
      editablePolicySignature({
        ...policy,
        defaultFallback: { models: [], fallbackOn: 'transient' },
      }),
    ).not.toBe(editablePolicySignature(policy));
  });

  test('the Advanced disclosure opens by default only when a vision override or a generation parameter is already set', () => {
    expect(hasAdvancedRoutingConfig({ visionModel: null, modelGenerationConfig: {} })).toBe(false);
    expect(hasAdvancedRoutingConfig({ visionModel: null, modelGenerationConfig: undefined })).toBe(
      false,
    );
    expect(
      hasAdvancedRoutingConfig({
        visionModel: null,
        modelGenerationConfig: { 'glm-5.3-flash': {} },
      }),
    ).toBe(false);
    expect(
      hasAdvancedRoutingConfig({
        visionModel: 'anthropic/claude-sonnet-4.6',
        modelGenerationConfig: {},
      }),
    ).toBe(true);
    expect(
      hasAdvancedRoutingConfig({
        visionModel: null,
        modelGenerationConfig: { 'glm-5.3-flash': { temperature: 0.5 } },
      }),
    ).toBe(true);
  });

  test('modelGenerationConfig is part of the dirty check and the hydration signature', () => {
    const policy = {
      defaultModel: 'codex/gpt-5.6-sol',
      visionModel: null,
      defaultFallback: null,
      rules: [],
      modelGenerationConfig: {},
    };
    expect(
      editablePolicySignature({
        ...policy,
        modelGenerationConfig: { 'codex/gpt-5.6-sol': { temperature: 0.5 } },
      }),
    ).not.toBe(editablePolicySignature(policy));
  });
});
