import type { CatalogReasoningOption } from '@kortix/llm-catalog';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import {
  canonicalFreeManagedModelId,
  freeLineupRevision,
  getFreeManagedModel,
  isFreeManagedModel,
  setFreeManagedModelsFromOpenRouterBody,
} from './free-models';

/**
 * A Dosco managed model: one model Platinum Inference or OpenRouter offers, paid from
 * credits or zero-cost for designated free models.
 */
export interface ManagedModel {
  id: string;
  name: string;
  upstreamModelId?: string;
  // Platinum's price per 1M tokens. The gateway bills Platinum's `usage.cost`;
  // this applies only when a response carries none.
  pricing: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number };
  // Image input. Also sets the served `attachment` and `modalities`: the
  // runtime drops image parts for a model that cannot take images.
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
 * The managed lineup: what Platinum Inference offers every Kortix user right
 * now, private models left out. Empty when the managed provider is off
 * (self-host) or Platinum was never reached.
 */
export function managedLineup(): readonly ManagedModel[] {
  return lineup;
}

/** Bumps on every paid or free lineup change, so derived caches know to rebuild. */
export function managedLineupRevision(): number {
  return revision + freeLineupRevision();
}

/** Any managed chat model served on this deployment, private and free models included. */
export function getRuntimeManagedModel(id: string): ManagedModel | undefined {
  return byId.get(id) ?? byId.get(canonicalManagedModelId(id)) ?? getFreeManagedModel(id);
}

/** In the lineup: a private model is not. */
export function isRuntimeManagedModelId(id: string): boolean {
  if (isFreeManagedModel(id)) return true;
  const model = byId.get(id);
  return !!model && !model.private;
}

/** A managed audio model Platinum serves now. */
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
];

interface OpenRouterPaidModelEntry {
  id?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown };
  context_length?: unknown;
  architecture?: { input_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
}

function perTokenToPerMillion(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

function paidOpenRouterModelsWithLivePrices(body: unknown): ManagedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [...DEFAULT_OPENROUTER_MANAGED_MODELS];
  const byUpstream = new Map<string, OpenRouterPaidModelEntry>();
  for (const item of data as OpenRouterPaidModelEntry[]) {
    if (typeof item?.id === 'string') byUpstream.set(item.id, item);
  }
  return DEFAULT_OPENROUTER_MANAGED_MODELS.map((model) => {
    const live = model.upstreamModelId ? byUpstream.get(model.upstreamModelId) : undefined;
    if (!live) return model;
    const input = perTokenToPerMillion(live.pricing?.prompt);
    const output = perTokenToPerMillion(live.pricing?.completion);
    const cached = perTokenToPerMillion(live.pricing?.input_cache_read);
    const context =
      typeof live.context_length === 'number' && live.context_length > 0
        ? live.context_length
        : model.limit.context;
    const rawOut = live.top_provider?.max_completion_tokens;
    const maxOutput =
      typeof rawOut === 'number' && rawOut > 0 ? Math.min(rawOut, context) : model.limit.output;
    const inputModalities = Array.isArray(live.architecture?.input_modalities)
      ? live.architecture.input_modalities
      : null;
    return {
      ...model,
      pricing: {
        inputPerMillion: input ?? model.pricing.inputPerMillion,
        outputPerMillion: output ?? model.pricing.outputPerMillion,
        ...(cached !== undefined
          ? { cachedInputPerMillion: cached }
          : model.pricing.cachedInputPerMillion !== undefined
            ? { cachedInputPerMillion: model.pricing.cachedInputPerMillion }
            : {}),
      },
      vision: inputModalities ? inputModalities.includes('image') : model.vision,
      limit: { context, output: maxOutput },
    };
  });
}

async function readOpenRouterModels(baseUrl: string, apiKey: string, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Audio models served by Dosco's sovereign voice providers (Groq/Inworld, or OpenRouter fallback). */
function sovereignManagedAudioModelIds(): string[] {
  const ids: string[] = [];
  if (config.GROQ_API_KEY || config.OPENROUTER_API_KEY) {
    ids.push('whisper-large-v3', 'whisper-large-v3-turbo');
  }
  if (config.INWORLD_API_KEY || config.OPENROUTER_API_KEY) {
    ids.push('inworld-tts-2', 'inworld-tts-2-flash');
  }
  return ids;
}

/** Private low-latency models reserved for voice turn routing/vision; never listed in pickers. */
function sovereignVoicePrivateModels(): ManagedModel[] {
  const models: ManagedModel[] = [];
  if (config.GROQ_API_KEY) {
    models.push(
      {
        id: 'qwen3.8-27b',
        name: 'Qwen 3.8 27B (Voice)',
        upstreamModelId: config.VOICE_GROQ_FAST_MODEL?.trim() || 'qwen/qwen3.8-27b',
        pricing: { inputPerMillion: 0.29, outputPerMillion: 0.59 },
        vision: false,
        limit: { context: 131072, output: 16384 },
        private: true,
      },
      {
        id: 'gpt-oss-20b',
        name: 'GPT-OSS 20B (Voice)',
        upstreamModelId: 'openai/gpt-oss-20b',
        pricing: { inputPerMillion: 0.075, outputPerMillion: 0.3 },
        vision: false,
        limit: { context: 131072, output: 16384 },
        private: true,
      },
    );
  } else if (config.OPENROUTER_API_KEY) {
    models.push(
      {
        id: 'qwen3.8-27b',
        name: 'Qwen 3.8 27B (Voice)',
        upstreamModelId: 'qwen/qwen3.7-flash',
        pricing: { inputPerMillion: 0.03, outputPerMillion: 0.13 },
        vision: false,
        limit: { context: 1000000, output: 16384 },
        private: true,
      },
      {
        id: 'gpt-oss-20b',
        name: 'GPT-OSS 20B (Voice)',
        upstreamModelId: 'openai/gpt-oss-20b',
        pricing: { inputPerMillion: 0.05, outputPerMillion: 0.2 },
        vision: false,
        limit: { context: 131072, output: 16384 },
        private: true,
      },
    );
  }
  if (config.OPENROUTER_API_KEY) {
    models.push({
      id: 'gemini-3.5-flash-lite',
      name: 'Gemini 3.5 Flash Lite (Voice)',
      upstreamModelId: 'google/gemini-2.5-flash-lite',
      pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
      vision: true,
      limit: { context: 1048576, output: 16384 },
      private: true,
    });
  }
  return models;
}

/**
 * Reads Platinum's `/models` into the lineup, or loads sovereign OpenRouter + Groq/Inworld
 * models when Platinum is not configured (syncing live prices and `:free` additions).
 */
export async function loadManagedLineup(fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (
    !config.KORTIX_MANAGED_PROVIDER_ENABLED ||
    (!config.PLATINUM_INFERENCE_API_KEY &&
      !config.OPENROUTER_API_KEY &&
      !config.GROQ_API_KEY &&
      !config.INWORLD_API_KEY)
  ) {
    if (loaded.models.length || loaded.audio.length) setLineup([]);
    return true;
  }
  if (!config.PLATINUM_INFERENCE_API_KEY) {
    let paidModels: ManagedModel[] = [];
    if (config.OPENROUTER_API_KEY) {
      paidModels = [...DEFAULT_OPENROUTER_MANAGED_MODELS];
      const shouldFetchLive = fetchImpl !== fetch || !config.OPENROUTER_API_KEY.startsWith('sk-or-test');
      if (shouldFetchLive) {
        try {
          const body = await readOpenRouterModels(
            config.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1',
            config.OPENROUTER_API_KEY,
            fetchImpl,
          );
          paidModels = paidOpenRouterModelsWithLivePrices(body);
          if (config.KORTIX_MANAGED_FREE_TIER_ENABLED) {
            setFreeManagedModelsFromOpenRouterBody(body);
          }
        } catch (err) {
          logger.warn('[managed-lineup] OpenRouter /models sync failed; keeping fallback lineup', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const models = [...paidModels, ...sovereignVoicePrivateModels()];
    const audio = sovereignManagedAudioModelIds();
    if (JSON.stringify({ models, audio }) !== JSON.stringify(loaded)) {
      setLineup(models, audio);
      logger.info('[managed-lineup] loaded sovereign managed models', {
        models: paidModels.map((m) => m.id),
        audio,
      });
    }
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
  // 2026-10-19: Kimi K3 left the managed lineup; its sessions move to the default.
  'kimi-k3',
]);

const OPENROUTER_ALIASES: Record<string, string> = {
  'deepseek/deepseek-v4.1-flash': 'deepseek-v4.1-flash',
  'qwen/qwen3-coder-30b-a3b-instruct': 'qwen3-coder',
  'qwen/qwen3.7-flash': 'qwen3.7-flash',
  'google/gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
};

/**
 * A stored managed id as the gateway should serve it: an alias or retired id becomes the
 * canonical model id.
 */
export function canonicalManagedModelId(id: string): string {
  const freeAlias = canonicalFreeManagedModelId(id);
  if (freeAlias) return freeAlias;
  const alias = OPENROUTER_ALIASES[id];
  if (alias) return alias;
  return RETIRED_MANAGED_MODEL_IDS.has(id) ? (lineup[0]?.id ?? id) : id;
}

/** In the current lineup, or an alias / retired id stored sessions may still carry. */
export function isKnownManagedModelId(id: string): boolean {
  return byId.has(id) || RETIRED_MANAGED_MODEL_IDS.has(id) || id in OPENROUTER_ALIASES || isFreeManagedModel(id);
}

/** Explicitly retired — distinct from merely "not currently servable". */
export function isRetiredManagedModelId(id: string): boolean {
  return RETIRED_MANAGED_MODEL_IDS.has(id);
}

/** Strip the runtime's `kortix/` provider namespace off a managed ref. */
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

export { FREE_MANAGED_MODELS } from './free-models';
