import type { CatalogReasoningOption } from '@kortix/llm-catalog';
import type { ManagedModel } from './managed-models';

const OPENROUTER_FREE_PREFIX_RE = /^(?:openrouter\/|free-)/i;
const PRESERVED_FREE_SLUGS: Record<string, string> = {
  'openrouter/free': 'openrouter-free',
  'cohere/north-mini-code:free': 'north-mini-code',
  'nvidia/nemotron-3.5-super-vl:free': 'nemotron-super-vl',
};

const ZERO_PRICING = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cachedInputPerMillion: 0,
} as const;

const DEFAULT_EFFORT_OPTIONS: CatalogReasoningOption[] = [
  { type: 'effort', values: ['low', 'medium', 'high'] },
];

/**
 * Curated fallback lineup of zero-cost tool-capable models from OpenRouter
 * (`https://openrouter.ai/models?variant=free`). Refreshed live on boot and
 * every 5 minutes from OpenRouter `/api/v1/models` when OpenRouter is configured.
 */
export const FREE_MANAGED_MODELS: readonly ManagedModel[] = [
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free',
    upstreamModelId: 'openrouter/free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 200_000, output: 16_384 },
  },
  {
    id: 'gemma-4-31b-it-free',
    name: 'Google: Gemma 4 31B',
    upstreamModelId: 'google/gemma-4-31b-it:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 262_144, output: 32_768 },
  },
  {
    id: 'gemma-4-26b-a4b-it-free',
    name: 'Google: Gemma 4 26B A4B',
    upstreamModelId: 'google/gemma-4-26b-a4b-it:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 262_144, output: 32_768 },
  },
  {
    id: 'ling-3.2-flash-free',
    name: 'InclusionAI: Ling 3.2 Flash',
    upstreamModelId: 'inclusionai/ling-3.2-flash:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_048_576, output: 262_144 },
  },
  {
    id: 'ernie-5.5-flash-preview-free',
    name: 'Baidu: ERNIE 5.5 Flash Preview',
    upstreamModelId: 'baidu/ernie-5.5-flash-preview:free',
    pricing: { ...ZERO_PRICING },
    vision: false,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_024_000, output: 131_072 },
  },
  {
    id: 'inkling-2-small-free',
    name: 'Thinking Machines: Inkling 2 Small',
    upstreamModelId: 'thinkingmachines/inkling-2-small:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_048_576, output: 131_072 },
  },
  {
    id: 'particle-1-free',
    name: 'Particle AI: Particle 1',
    upstreamModelId: 'particle-ai/particle-1:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_048_576, output: 131_072 },
  },
  {
    id: 'nemotron-3-ultra-550b-a55b-free',
    name: 'NVIDIA: Nemotron 3 Ultra 550B',
    upstreamModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    pricing: { ...ZERO_PRICING },
    vision: false,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_000_000, output: 65_536 },
  },
  {
    id: 'nemotron-super-vl',
    name: 'NVIDIA: Nemotron 3.5 Super VL',
    upstreamModelId: 'nvidia/nemotron-3.5-super-vl:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_000_000, output: 131_072 },
  },
  {
    id: 'nemotron-3.5-lightning-free',
    name: 'NVIDIA: Nemotron 3.5 Lightning',
    upstreamModelId: 'nvidia/nemotron-3.5-lightning:free',
    pricing: { ...ZERO_PRICING },
    vision: false,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 1_000_000, output: 65_536 },
  },
  {
    id: 'nemotron-3-nano-omni-30b-a3b-reasoning-free',
    name: 'NVIDIA: Nemotron 3 Nano Omni 30B',
    upstreamModelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 256_000, output: 65_536 },
  },
  {
    id: 'dots-3-note-preview-free',
    name: 'Dots Studio: Dots 3 Note Preview',
    upstreamModelId: 'dots-studio/dots-3-note-preview:free',
    pricing: { ...ZERO_PRICING },
    vision: true,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 512_000, output: 131_072 },
  },
  {
    id: 'flint-v1.0-free',
    name: 'Recursive: Flint v1.0',
    upstreamModelId: 'recursive/flint-v1.0:free',
    pricing: { ...ZERO_PRICING },
    vision: false,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 262_144, output: 131_072 },
  },
  {
    id: 'north-mini-code',
    name: 'Cohere: North Mini Code',
    upstreamModelId: 'cohere/north-mini-code:free',
    pricing: { ...ZERO_PRICING },
    vision: false,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 256_000, output: 64_000 },
  },
  {
    id: 'lfm-3-1.7b-free',
    name: 'Liquid: LFM 3 1.7B',
    upstreamModelId: 'liquid/lfm-3-1.7b:free',
    pricing: { ...ZERO_PRICING },
    vision: false,
    reasoningOptions: DEFAULT_EFFORT_OPTIONS,
    limit: { context: 262_144, output: 8_192 },
  },
];

interface OpenRouterCatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
}

function isZeroUsd(raw: unknown): boolean {
  if (typeof raw === 'number') return raw === 0;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    const n = Number(trimmed);
    return Number.isFinite(n) && n === 0;
  }
  return false;
}

/**
 * Deterministic gateway slug for an OpenRouter `:free` upstream id. Preserves
 * historical slugs (`openrouter-free`, `north-mini-code`, `nemotron-super-vl`).
 */
export function freeSlugForOpenRouterId(upstreamId: string, used?: Set<string>): string {
  const preserved = PRESERVED_FREE_SLUGS[upstreamId];
  if (preserved) {
    used?.add(preserved);
    return preserved;
  }
  const slash = upstreamId.indexOf('/');
  const vendor = slash === -1 ? '' : upstreamId.slice(0, slash);
  const tail = (slash === -1 ? upstreamId : upstreamId.slice(slash + 1)).replace(/:free$/i, '');
  let candidate = `${tail}-free`.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();
  if (used?.has(candidate) && vendor) {
    candidate = `${vendor}-${candidate}`.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();
  }
  used?.add(candidate);
  return candidate;
}

function cleanOpenRouterDisplayName(rawId: string, rawName: unknown): string {
  if (rawId === 'openrouter/free') return 'OpenRouter Free';
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : rawId;
  return name.replace(/\s*\(free\)\s*$/i, '').replace(/\s*:free\s*$/i, '').trim() || rawId;
}

/**
 * Extracts zero-cost, tool-capable models from OpenRouter's `/api/v1/models` payload.
 * Audio-only or non-tool models (e.g. `lyria-3-*`) are excluded so Free sessions
 * can execute agent tools reliably.
 */
export function freeModelsFromOpenRouterBody(body: unknown): ManagedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const usedSlugs = new Set<string>();
  const parsed: ManagedModel[] = [];

  for (const raw of data as OpenRouterCatalogEntry[]) {
    if (typeof raw?.id !== 'string' || !raw.id) continue;
    if (raw.id !== 'openrouter/free' && !raw.id.endsWith(':free')) continue;
    if (!isZeroUsd(raw.pricing?.prompt) || !isZeroUsd(raw.pricing?.completion)) continue;

    const params = Array.isArray(raw.supported_parameters)
      ? raw.supported_parameters.filter((p): p is string => typeof p === 'string')
      : [];
    if (!params.includes('tools')) continue;

    const id = freeSlugForOpenRouterId(raw.id, usedSlugs);
    const inputModalities = Array.isArray(raw.architecture?.input_modalities)
      ? raw.architecture.input_modalities
      : [];
    const vision = inputModalities.includes('image') || raw.id === 'openrouter/free';
    const supportsReasoning = params.includes('reasoning') || params.includes('reasoning_effort');
    const context =
      typeof raw.context_length === 'number' && raw.context_length > 0
        ? raw.context_length
        : 128_000;
    const rawOutput = raw.top_provider?.max_completion_tokens;
    const output =
      typeof rawOutput === 'number' && rawOutput > 0
        ? Math.min(rawOutput, context)
        : Math.min(32_768, context);

    parsed.push({
      id,
      name: cleanOpenRouterDisplayName(raw.id, raw.name),
      upstreamModelId: raw.id,
      pricing: { ...ZERO_PRICING },
      vision,
      ...(supportsReasoning ? { reasoningOptions: DEFAULT_EFFORT_OPTIONS } : {}),
      limit: { context, output },
    });
  }

  // Keep `openrouter-free` (the OpenRouter Free Models Router) first so it stays the default.
  parsed.sort((a, b) => {
    if (a.id === 'openrouter-free') return -1;
    if (b.id === 'openrouter-free') return 1;
    return 0;
  });

  return parsed;
}

let currentFreeLineup: readonly ManagedModel[] = FREE_MANAGED_MODELS;
let freeById = new Map<string, ManagedModel>();
let freeAliasToSlug = new Map<string, string>();
let freeRevision = 0;

function rebuildFreeIndexes(models: readonly ManagedModel[]): void {
  const nextById = new Map<string, ManagedModel>();
  const nextAliases = new Map<string, string>();
  for (const model of models) {
    nextById.set(model.id, model);
    if (model.upstreamModelId) {
      nextAliases.set(model.upstreamModelId, model.id);
    }
  }
  currentFreeLineup = models;
  freeById = nextById;
  freeAliasToSlug = nextAliases;
}

rebuildFreeIndexes(FREE_MANAGED_MODELS);

export const FREE_MANAGED_MODEL_IDS = new Set<string>(freeById.keys());

/** Current runtime free lineup (OpenRouter live `:free` models or curated fallback). */
export function freeManagedModels(): readonly ManagedModel[] {
  return currentFreeLineup;
}

/** Increments whenever the runtime free lineup changes so downstream caches rebuild. */
export function freeLineupRevision(): number {
  return freeRevision;
}

/** Updates the runtime free lineup from an OpenRouter `/models` payload if non-empty. */
export function setFreeManagedModelsFromOpenRouterBody(body: unknown): boolean {
  const models = freeModelsFromOpenRouterBody(body);
  if (models.length === 0) return false;
  if (JSON.stringify(models) !== JSON.stringify(currentFreeLineup)) {
    rebuildFreeIndexes(models);
    freeRevision++;
  }
  return true;
}

export function __resetFreeManagedModelsForTest(): void {
  if (JSON.stringify(currentFreeLineup) !== JSON.stringify(FREE_MANAGED_MODELS)) {
    rebuildFreeIndexes(FREE_MANAGED_MODELS);
    freeRevision++;
  }
}

function stripKortixPrefix(ref: string): string {
  return ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
}

/** Resolves a slug or raw OpenRouter `:free` id (`google/gemma-4-31b-it:free`) to its slug. */
export function canonicalFreeManagedModelId(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const wire = stripKortixPrefix(ref.trim());
  if (freeById.has(wire)) return wire;
  return freeAliasToSlug.get(wire) ?? null;
}

/** True when the model ref is one of Dosco's designated free managed models. */
export function isFreeManagedModel(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const trimmed = ref.trim();
  if (!trimmed || (trimmed.startsWith('openrouter/') && trimmed !== 'openrouter/free' && !trimmed.endsWith(':free'))) {
    // Allow plain openrouter-free while keeping generic BYOK `openrouter/<paid>` distinct unless matching a free alias.
    if (OPENROUTER_FREE_PREFIX_RE.test(trimmed) && freeAliasToSlug.has(trimmed)) return true;
  }
  return canonicalFreeManagedModelId(trimmed) !== null;
}

/** Get the ManagedModel definition for a free model (by slug or upstream OpenRouter id). */
export function getFreeManagedModel(id: string): ManagedModel | undefined {
  const slug = canonicalFreeManagedModelId(id);
  return slug ? freeById.get(slug) : undefined;
}

/** The default free model served when an account is on the Free tier. */
export function platformDefaultFreeModelId(): string {
  return 'openrouter-free';
}
