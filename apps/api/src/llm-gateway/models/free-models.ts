import type { ManagedModel } from './managed-models';

/**
 * Designated Free Managed Models available to Free-tier accounts on Dosco.
 * These models have 0 credit cost and allow users without paid subscriptions
 * or BYOK credentials to execute agent sessions seamlessly on Pi.
 */
export const FREE_MANAGED_MODELS: readonly ManagedModel[] = [
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    upstreamModelId: 'deepseek/deepseek-v4.1-flash-free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    limit: { context: 1_000_000, output: 65_536 },
  },
  {
    id: 'deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash Free',
    upstreamModelId: 'deepseek/deepseek-v4-flash-free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    limit: { context: 128_000, output: 8_192 },
  },
  {
    id: 'mimo-v2.5-free',
    name: 'MiMo V2.5 Free',
    upstreamModelId: 'mimo/mimo-v2.5-free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: false,
    limit: { context: 256_000, output: 8_192 },
  },
  {
    id: 'big-pickle',
    name: 'Big Pickle (Free Reasoning)',
    upstreamModelId: 'opencode/big-pickle',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: false,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    limit: { context: 200_000, output: 32_000 },
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free (Auto-Failover)',
    upstreamModelId: 'openrouter/free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: false,
    limit: { context: 200_000, output: 8_192 },
  },
  {
    id: 'north-mini-code',
    name: 'Cohere North Mini Code (Free)',
    upstreamModelId: 'cohere/north-mini-code:free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: false,
    limit: { context: 256_000, output: 8_192 },
  },
  {
    id: 'nemotron-super-vl',
    name: 'Nemotron 3.5 Super VL (Free Vision)',
    upstreamModelId: 'nvidia/nemotron-3.5-super-vl:free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    limit: { context: 1_000_000, output: 8_192 },
  },
];

const FREE_MODEL_BY_ID = new Map<string, ManagedModel>(
  FREE_MANAGED_MODELS.map((m) => [m.id, m]),
);

export const FREE_MANAGED_MODEL_IDS = new Set<string>(FREE_MODEL_BY_ID.keys());

/** True when the model ref is one of Dosco's designated free managed models. */
export function isFreeManagedModel(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const wire = ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
  return FREE_MANAGED_MODEL_IDS.has(wire);
}

/** Get the ManagedModel definition for a free model. */
export function getFreeManagedModel(id: string): ManagedModel | undefined {
  const wire = id.startsWith('kortix/') ? id.slice('kortix/'.length) : id;
  return FREE_MODEL_BY_ID.get(wire);
}

/** The default free model served when an account is on the Free tier. */
export function platformDefaultFreeModelId(): string {
  return 'deepseek-v4.1-flash-free';
}
