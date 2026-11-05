import type { CatalogReasoningOption } from '@kortix/llm-catalog';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import {
  FREE_MANAGED_MODELS,
  isFreeManagedModel,
  getFreeManagedModel,
} from './free-models';

export {
  FREE_MANAGED_MODELS,
  isFreeManagedModel,
  getFreeManagedModel,
};

/**
 * A Dosco managed model: one model Platinum Inference offers, paid from
 * Dosco credits. Platinum's `GET /v1/inference/models` is the only source;
 * nothing here lists or prices a model.
 */
export interface ManagedModel {
  id: string;
  name: string;
  upstreamModelId?: string;
  // Platinum's price per 1M tokens. The gateway bills Platinum's `usage.cost`;
  // this applies only when a response carries none.
  pricing: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number };
  // Image input. Also sets the served `modalities`: OpenCode drops image parts
  // for a model without `image` input.
  vision: boolean;
  // `reasoning_effort` values Platinum accepts; the thinking control's variants.
  reasoningOptions?: CatalogReasoningOption[];
  limit: { context: number; output: number };
  /**
   * Platinum serves it only to the orgs granted it (`private: true`): it
   * answers by its id and is never listed (lineup, picker, default, fallback).
   */
  private?: true;
}

/** One entry of Platinum's `/models` list, as far as this file reads it. */
type PlatinumModel = {
  id?: unknown; name?: unknown; owned_by?: unknown; private?: unknown;
  context_length?: unknown; max_output_tokens?: unknown;
  pricing?: { input?: unknown; cached_input?: unknown; output?: unknown; audio_hour?: unknown; characters_million?: unknown };
  modalities?: { input?: unknown };
  reasoning_efforts?: unknown;
};

function platinumList(body: unknown): PlatinumModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Platinum /models answered without a data list');
  return data as PlatinumModel[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * Platinum's named chat models, in Platinum's order. Entries without a token
 * price are skipped: an audio model is priced per hour or per character.
 */
export function managedModelsFromPlatinum(body: unknown): ManagedModel[] {
  const out: ManagedModel[] = [];
  for (const m of platinumList(body)) {
    const input = num(m.pricing?.input);
    const output = num(m.pricing?.output);
    const context = num(m.context_length);
    const maxOutput = num(m.max_output_tokens);
    if (m.owned_by !== 'platinum' || typeof m.id !== 'string' || !m.id || input === undefined || output === undefined
      || !context || !maxOutput) continue;
    const cached = num(m.pricing?.cached_input);
    const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.filter((e): e is string => typeof e === 'string') : [];
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      pricing: { inputPerMillion: input, outputPerMillion: output, ...(cached !== undefined ? { cachedInputPerMillion: cached } : {}) },
      vision: Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'),
      ...(efforts.length ? { reasoningOptions: [{ type: 'effort', values: efforts }] as CatalogReasoningOption[] } : {}),
      limit: { context, output: maxOutput },
      ...(m.private === true ? { private: true as const } : {}),
    });
  }
  return out;
}

/**
 * Platinum's audio models (`/audio/transcriptions`, `/audio/speech`), by id:
 * priced per audio hour or per 1M characters. The gateway bills the price
 * each audio answer reports.
 */
export function managedAudioModelIdsFromPlatinum(body: unknown): string[] {
  return platinumList(body)
    .filter((m) => m.owned_by === 'platinum' && typeof m.id === 'string' && m.id
      && (num(m.pricing?.audio_hour) !== undefined || num(m.pricing?.characters_million) !== undefined))
    .map((m) => m.id as string);
}

/** The last list read, private and audio models included: what a reload compares with. */
let loaded: { models: readonly ManagedModel[]; audio: readonly string[] } = { models: [], audio: [] };
let lineup: readonly ManagedModel[] = [];
// replica-local: every replica loads the same Platinum list and refreshes it
// every 5 min (replica/managed-lineup.ts); a copy is at most that old.
let byId = new Map<string, ManagedModel>();
// replica-local: read from the same Platinum list as `byId`, at the same time.
let audioIds = new Set<string>();
let revision = 0;

function setLineup(models: readonly ManagedModel[], audio: readonly string[] = []): void {
  loaded = { models, audio };
  lineup = models.filter((model) => !model.private);
  byId = new Map(models.map((model) => [model.id, model] as const));
  audioIds = new Set(audio);
  revision++;
}

/**
 * The managed lineup: what Platinum Inference offers every Dosco user right
 * now, private models left out. Empty when the managed provider is off
 * (self-host) or Platinum was never reached.
 */
export function managedLineup(): readonly ManagedModel[] {
  return lineup;
}

/** Bumps on every lineup change, so derived caches know to rebuild. */
export function managedLineupRevision(): number {
  return revision;
}

/** Any managed chat model Platinum serves Dosco, a private one included. */
export function getRuntimeManagedModel(id: string): ManagedModel | undefined {
  return byId.get(id) ?? getFreeManagedModel(id);
}

/** In the lineup: a private model is not. */
export function isRuntimeManagedModelId(id: string): boolean {
  const model = byId.get(id);
  return (!!model && !model.private) || isFreeManagedModel(id);
}

/** A managed audio model Platinum serves Dosco now. */
export function isManagedAudioModelId(id: string): boolean {
  return audioIds.has(id);
}

export function __setManagedLineupForTest(models: readonly ManagedModel[], audio: readonly string[] = []): void {
  setLineup(models, audio);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const LOAD_TIMEOUT_MS = 10_000;

/** HTTP status of a failed Platinum `/models` read, so a caller can tell a bad key from an outage. */
export class PlatinumModelsError extends Error {
  constructor(readonly status: number | null, message: string) { super(message); }
}

/**
 * Platinum's model list for one key: `GET {baseUrl}/models`. The one reader
 * for both the managed lineup (the deployment's key) and the Platinum BYOK
 * provider (a project's own key, platinum-byok-models.ts).
 */
async function readPlatinumModels(baseUrl: string, apiKey: string, fetchImpl: FetchLike): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlatinumModelsError(null, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new PlatinumModelsError(res.status, `HTTP ${res.status}`);
  return res.json();
}

/** Platinum's named chat models for one key. */
export async function fetchPlatinumModels(baseUrl: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<ManagedModel[]> {
  return managedModelsFromPlatinum(await readPlatinumModels(baseUrl, apiKey, fetchImpl));
}

/**
 * Reads Platinum's `/models` into the lineup. On any failure the last good
 * lineup stays and the error is logged; returns whether the read succeeded.
 */
export const DEFAULT_OPENROUTER_MANAGED_MODELS: readonly ManagedModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    upstreamModelId: 'deepseek/deepseek-v4.1-flash',
    pricing: { inputPerMillion: 0.02, outputPerMillion: 1.0 },
    vision: false,
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    limit: { context: 1048576, output: 16384 },
  },
  {
    id: 'qwen3-coder',
    name: 'Qwen 3 Coder 30B',
    upstreamModelId: 'qwen/qwen3-coder-30b-a3b-instruct',
    pricing: { inputPerMillion: 0.07, outputPerMillion: 0.28 },
    vision: false,
    limit: { context: 262144, output: 16384 },
  },
  {
    id: 'qwen3.7-flash',
    name: 'Qwen 3.7 Flash',
    upstreamModelId: 'qwen/qwen3.7-flash',
    pricing: { inputPerMillion: 0.03, outputPerMillion: 0.13 },
    vision: false,
    limit: { context: 1000000, output: 16384 },
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    upstreamModelId: 'google/gemini-2.5-flash-lite',
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40 },
    vision: true,
    limit: { context: 1048576, output: 16384 },
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free',
    upstreamModelId: 'openrouter/free',
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    vision: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
    limit: { context: 200000, output: 8192 },
  },
];

export async function loadManagedLineup(fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (!config.KORTIX_MANAGED_PROVIDER_ENABLED || (!config.PLATINUM_INFERENCE_API_KEY && !config.OPENROUTER_API_KEY)) {
    if (loaded.models.length || loaded.audio.length) setLineup([]);
    return true;
  }
  if (config.OPENROUTER_API_KEY && !config.PLATINUM_INFERENCE_API_KEY) {
    const models = config.KORTIX_MANAGED_FREE_TIER_ENABLED
      ? DEFAULT_OPENROUTER_MANAGED_MODELS
      : DEFAULT_OPENROUTER_MANAGED_MODELS.filter(
          (m) => m.pricing.inputPerMillion > 0 || m.pricing.outputPerMillion > 0,
        );
    setLineup(models);
    logger.info('[managed-lineup] loaded OpenRouter managed models', {
      models: models.map((m) => m.id),
    });
    return true;
  }
  try {
    const body = await readPlatinumModels(config.PLATINUM_INFERENCE_URL, config.PLATINUM_INFERENCE_API_KEY!, fetchImpl);
    const models = managedModelsFromPlatinum(body);
    const audio = managedAudioModelIdsFromPlatinum(body);
    if (JSON.stringify({ models, audio }) !== JSON.stringify(loaded)) {
      setLineup(models, audio);
      logger.info('[managed-lineup] loaded from Platinum Inference', { models: models.map((m) => m.id), audio });
    }
    return true;
  } catch (err) {
    logger.warn('[managed-lineup] Platinum /models failed; keeping the last lineup', {
      error: err instanceof Error ? err.message : String(err), kept: lineup.length,
    });
    return false;
  }
}

const RETIRED_MANAGED_MODEL_IDS = new Set([
  'glm-5.2', 'grok-4.6', 'deepseek-v4-flash', 'deepseek-v4-pro-0813',
  'muse-spark-1.2', 'minimax-m3', 'gpt-5.6-luna', 'gpt-6-astra',
  'morph-glm53-744b', 'morph-dsv4flash', 'morph-kimik3',
  'morph-kimik3-fast', 'morph-dsv41flash',
  'deepseek-v4-flash-0731', 'kimi-k3-fast',
  'deepseek-v4.1-flash-free',
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'big-pickle',
  'north-mini-code',
  'nemotron-super-vl',
  // 2026-10-19: Kimi K3 left the managed lineup; its sessions move to the default.
  'kimi-k3',
]);

const OPENROUTER_ALIASES: Record<string, string> = {
  'deepseek/deepseek-v4.1-flash': 'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-free': 'openrouter-free',
  'deepseek-v4-flash-free': 'openrouter-free',
  'mimo-v2.5-free': 'openrouter-free',
  'big-pickle': 'openrouter-free',
  'north-mini-code': 'openrouter-free',
  'nemotron-super-vl': 'openrouter-free',
  'qwen/qwen3-coder-30b-a3b-instruct': 'qwen3-coder',
  'qwen/qwen3.7-flash': 'qwen3.7-flash',
  'google/gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'openrouter/free': 'openrouter-free',
  'cohere/north-mini-code:free': 'openrouter-free',
  'nvidia/nemotron-3.5-super-vl:free': 'openrouter-free',
  'mimo/mimo-v2.5-free': 'openrouter-free',
  'opencode/big-pickle': 'openrouter-free',
};

/**
 * A stored managed id as the gateway should serve it: a retired id becomes the
 * first model Platinum lists (its preferred default); anything else is itself.
 * No successor is hardcoded: the lineup decides.
 */
export function canonicalManagedModelId(id: string): string {
  const alias = OPENROUTER_ALIASES[id];
  if (alias) return alias;
  return RETIRED_MANAGED_MODEL_IDS.has(id) ? (lineup[0]?.id ?? id) : id;
}

/** In the current lineup, a designated free model, or a retired id stored sessions may still carry. */
export function isKnownManagedModelId(id: string): boolean {
  return byId.has(id) || isFreeManagedModel(id) || RETIRED_MANAGED_MODEL_IDS.has(id) || id in OPENROUTER_ALIASES;
}

/** Explicitly retired — distinct from merely "not currently servable". */
export function isRetiredManagedModelId(id: string): boolean {
  return RETIRED_MANAGED_MODEL_IDS.has(id);
}

/** Strip the opencode `kortix/` namespace off a managed ref. */
function bareManagedId(ref: string): string {
  return ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
}

/**
 * The platform default model, guaranteed reachable.
 *
 * `configured` (`LLM_GATEWAY_DEFAULT_MODEL`) is what an operator asked for.
 * Empty, or a managed id Platinum does not serve now: the first served model
 * (Platinum lists in order of preference). A BYOK ref (`provider/model`) is
 * returned untouched: it resolves from a project key, and
 * `degradeUnservableDefault` probes that case per project.
 */
export function resolvePlatformDefaultModelId(
  configured: string,
  served: readonly ManagedModel[],
): string {
  const trimmed = configured.trim();
  if (trimmed.includes('/') && !trimmed.startsWith('kortix/')) return trimmed;
  const bare = bareManagedId(trimmed);
  if (bare && served.some((model) => model.id === bare)) return trimmed;
  return served[0]?.id ?? trimmed;
}
