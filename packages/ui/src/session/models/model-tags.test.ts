import { describe, expect, test } from 'bun:test';
import { isSubscriptionModel, modelSourceBadge, pickerModelName, shouldShowFreeTag } from './model-tags';

const model = (modelID: string, modelName: string, provider?: string) =>
  ({ modelID, modelName, provider, free: false }) as never;

describe('isSubscriptionModel', () => {
  test('recognises the explicit provider field', () => {
    expect(isSubscriptionModel(model('codex/gpt-6-astra', 'x', 'codex'))).toBe(true);
  });

  test('falls back to the wire id for a stale catalog with no provider field', () => {
    expect(isSubscriptionModel(model('codex/gpt-6-astra', 'x'))).toBe(true);
  });

  test('a managed model of the same family is not a subscription model', () => {
    expect(isSubscriptionModel(model('gpt-6-astra', 'x', 'kortix'))).toBe(false);
  });

  test('a BYOK OpenAI model is not a subscription model', () => {
    expect(isSubscriptionModel(model('openai/gpt-5.5', 'x', 'openai'))).toBe(false);
  });
});

describe('pickerModelName', () => {
  test('drops the suffix the group heading already says', () => {
    expect(pickerModelName(model('codex/gpt-6-astra', 'GPT-6 Astra (ChatGPT)', 'codex'))).toBe(
      'GPT-6 Astra',
    );
  });

  test('the managed twin is untouched â€” both read the same in their own group', () => {
    expect(pickerModelName(model('gpt-6-astra', 'GPT-6 Astra', 'kortix'))).toBe('GPT-6 Astra');
  });

  test('a subscription model without the suffix is left alone', () => {
    expect(pickerModelName(model('codex/gpt-5.5', 'GPT-5.5', 'codex'))).toBe('GPT-5.5');
  });

  test('never returns an empty label, whatever the catalog says', () => {
    expect(pickerModelName(model('codex/x', '(ChatGPT)', 'codex'))).toBe('(ChatGPT)');
  });

  test('a non-subscription model keeps a parenthetical that is part of its name', () => {
    expect(pickerModelName(model('openai/o1', 'o1 (ChatGPT)', 'openai'))).toBe('o1 (ChatGPT)');
  });
});

describe('shouldShowFreeTag is unchanged', () => {
  test('still keys off the free flag', () => {
    expect(shouldShowFreeTag({ free: true, modelID: 'a', modelName: 'b' })).toBe(true);
  });
});

describe('modelSourceBadge', () => {
  test('identifies OpenCode models by provider, prefix, or id', () => {
    expect(modelSourceBadge({ modelID: 'opencode/claude-3-5', modelName: 'Claude' })).toBe('OpenCode');
    expect(modelSourceBadge({ modelID: 'big-pickle', modelName: 'Big Pickle' })).toBe('OpenCode');
    expect(modelSourceBadge({ modelID: 'glm-4', modelName: 'GLM', provider: 'opencode-go' })).toBe('OpenCode');
  });

  test('identifies OpenRouter models by provider, prefix, or name', () => {
    expect(modelSourceBadge({ modelID: 'openrouter/free', modelName: 'Auto' })).toBe('OpenRouter');
    expect(modelSourceBadge({ modelID: 'openrouter/deepseek-chat', modelName: 'DeepSeek Chat' })).toBe('OpenRouter');
    expect(modelSourceBadge({ modelID: 'openrouter-free', modelName: 'OpenRouter Free' })).toBe('OpenRouter');
    expect(modelSourceBadge({ modelID: 'some-model', modelName: 'Model', provider: 'openrouter' })).toBe('OpenRouter');
  });

  test('does not mislabel platform managed models as OpenRouter', () => {
    expect(modelSourceBadge({ modelID: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash' })).toBeNull();
    expect(modelSourceBadge({ modelID: 'qwen3-coder', modelName: 'Qwen 3 Coder' })).toBeNull();
  });

  test('returns null for standard BYOK providers without OpenCode/OpenRouter routing', () => {
    expect(modelSourceBadge({ modelID: 'anthropic/claude-3-5-sonnet', modelName: 'Claude 3.5 Sonnet', provider: 'anthropic' })).toBeNull();
    expect(modelSourceBadge({ modelID: 'openai/gpt-5.5', modelName: 'GPT-5.5', provider: 'openai' })).toBeNull();
  });
});


describe('pickerModelName drops every plan suffix', () => {
  test.each([
    ['claude-agent/claude-opus-5-5', 'Claude Opus 5.5 (Claude subscription)', 'claude-agent', 'Claude Opus 5.5'],
    ['claude-agent/claude-fable-5-1', 'Claude Fable 5.1 (Claude)', 'claude-agent', 'Claude Fable 5.1'],
    ['anthropic/claude-opus-5-5', 'Claude Opus 5.5 (Anthropic subscription)', 'anthropic', 'Claude Opus 5.5'],
    ['codex/gpt-6-luna', 'GPT-6 Luna (ChatGPT subscription)', 'codex', 'GPT-6 Luna'],
  ])('%s', (id, name, provider, expected) => {
    expect(pickerModelName(model(id, name, provider))).toBe(expected);
  });

  test('a parenthetical that is part of the model name stays', () => {
    expect(pickerModelName(model('openai/gpt-oss', 'GPT OSS (120B)', 'openai'))).toBe('GPT OSS (120B)');
  });
});
