import { describe, expect, test } from 'bun:test';
import type { FlatModel } from '@kortix/sdk/react';

import { curatePrimaryModels, modelSubtitle, type ModelSubtitleStrings } from './model-curation';

const SUBTITLES: ModelSubtitleStrings = {
  freeFast: 'Free, fast for everyday tasks',
  freeGeneral: 'Free, general-purpose tasks',
  reasoning: 'For complex work and deep reasoning',
  fast: 'Fastest for quick answers',
  balanced: 'Balanced for everyday work',
  general: 'General-purpose model',
};

function flat(
  partial: Partial<FlatModel> & Pick<FlatModel, 'providerID' | 'modelID'>,
): FlatModel {
  return {
    providerName: 'Dosco',
    modelName: partial.modelID,
    ...partial,
  };
}

describe('curatePrimaryModels', () => {
  test('deduplicates twin display names and prefers medium/selected effort variants', () => {
    const models = [
      flat({ providerID: 'antigravity', modelID: 'gemini-3-5-flash-lite-low', modelName: 'Gemini 3.5 Flash Lite', defaultEffort: 'low' }),
      flat({ providerID: 'antigravity', modelID: 'gemini-3-5-flash-lite-medium', modelName: 'Gemini 3.5 Flash Lite', defaultEffort: 'medium' }),
      flat({ providerID: 'antigravity', modelID: 'gemini-3-5-flash-lite-high', modelName: 'Gemini 3.5 Flash Lite', defaultEffort: 'high' }),
    ];

    const result = curatePrimaryModels({
      browseModels: models,
      pickableModels: models,
      selected: null,
      isFavorite: () => false,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.modelID).toBe('gemini-3-5-flash-lite-medium');

    const withSelectedHigh = curatePrimaryModels({
      browseModels: models,
      pickableModels: models,
      selected: { providerID: 'antigravity', modelID: 'gemini-3-5-flash-lite-high' },
      isFavorite: () => false,
    });
    expect(withSelectedHigh).toHaveLength(1);
    expect(withSelectedHigh[0]?.modelID).toBe('gemini-3-5-flash-lite-high');
  });

  test('caps curated list and always retains selected, favorites, and workspace default', () => {
    const models = [
      flat({ providerID: 'kortix', modelID: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', capabilities: { reasoning: true } }),
      flat({ providerID: 'kortix', modelID: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', capabilities: { reasoning: true } }),
      flat({ providerID: 'kortix', modelID: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5' }),
      flat({ providerID: 'kortix', modelID: 'gpt-5-4', modelName: 'GPT-5.4', capabilities: { reasoning: true } }),
      flat({ providerID: 'kortix', modelID: 'gpt-5-mini', modelName: 'GPT-5 Mini' }),
      flat({ providerID: 'kortix', modelID: 'deepseek-v3', modelName: 'DeepSeek V3', free: true }),
      flat({ providerID: 'openrouter', modelID: 'mistral/devstral', modelName: 'Devstral' }),
    ];

    const selected = { providerID: 'openrouter', modelID: 'mistral/devstral' };
    const fav = { providerID: 'kortix', modelID: 'claude-haiku-4-5' };
    const accountDefault = { providerID: 'kortix', modelID: 'gpt-5-mini' };

    const result = curatePrimaryModels({
      browseModels: models,
      pickableModels: models,
      selected,
      accountDefault,
      isFavorite: (m) => m.providerID === fav.providerID && m.modelID === fav.modelID,
      limit: 5,
    });

    expect(result).toHaveLength(5);
    expect(result.some((m) => m.modelID === selected.modelID)).toBe(true);
    expect(result.some((m) => m.modelID === fav.modelID)).toBe(true);
    expect(result.some((m) => m.modelID === accountDefault.modelID)).toBe(true);
  });

  test('includes starred favorites from pickableModels even if omitted from browseModels', () => {
    const browse = [flat({ providerID: 'kortix', modelID: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6' })];
    const hiddenFav = flat({ providerID: 'openrouter', modelID: 'qwen/qwen-3-coder', modelName: 'Qwen 3 Coder' });
    const pickable = [...browse, hiddenFav];

    const result = curatePrimaryModels({
      browseModels: browse,
      pickableModels: pickable,
      selected: null,
      isFavorite: (m) => m.modelID === hiddenFav.modelID,
    });

    expect(result.map((m) => m.modelID)).toContain(hiddenFav.modelID);
  });
});

describe('modelSubtitle', () => {
  test('prefers clean first sentence from model.description', () => {
    const m = flat({
      providerID: 'kortix',
      modelID: 'claude-opus-4-6',
      modelName: 'Claude Opus 4.6',
      description: 'Built for complex engineering workflows. Supports 200k context.',
    });
    expect(modelSubtitle(m, SUBTITLES)).toBe('Built for complex engineering workflows');
  });

  test('derives factual fallback subtitles from model traits', () => {
    expect(
      modelSubtitle(
        flat({ providerID: 'kortix', modelID: 'openrouter/free-flash', modelName: 'Free Flash', free: true }),
        SUBTITLES,
      ),
    ).toBe(SUBTITLES.freeFast);

    expect(
      modelSubtitle(
        flat({ providerID: 'kortix', modelID: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', capabilities: { reasoning: true } }),
        SUBTITLES,
      ),
    ).toBe(SUBTITLES.reasoning);

    expect(
      modelSubtitle(
        flat({ providerID: 'kortix', modelID: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5' }),
        SUBTITLES,
      ),
    ).toBe(SUBTITLES.fast);
  });
});
