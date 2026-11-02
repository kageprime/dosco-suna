import type { ManagedModel } from './managed-models';

/**
 * Designated Free Managed Models available to Free-tier accounts on Dosco.
 * These models have 0 credit cost and allow users without paid subscriptions
 * or BYOK credentials to execute agent sessions seamlessly on Pi.
 */
export const FREE_MANAGED_MODELS: readonly ManagedModel[] = [
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free',
    upstreamModelId: 'openrouter/free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
    vision: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    limit: { context: 200_000, output: 8_192 },
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
  return 'openrouter-free';
}
