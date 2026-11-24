import {
  ANTIGRAVITY_MODELS,
  type AntigravityEffort,
  type AntigravityModel,
} from '@kortix/api-contract/antigravity';
import { ANTIGRAVITY_HUB_USER_AGENT } from '@kortix/llm-gateway/transports/ai-sdk/cloudcode';

export { ANTIGRAVITY_HUB_USER_AGENT };

const CLOUDCODE_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUDCODE_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const;

const EFFORT_SUFFIX_RE = /-(low|medium|high|extra|max|tiered)$/;
const EFFORT_DISPLAY_RE = /\s*\((?:Low|Medium|High|Extra|Max)\)\s*$/i;
const EFFORT_ORDER: readonly AntigravityEffort[] = ['low', 'medium', 'high', 'extra', 'max'];
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CloudCodeModelDetails {
  displayName?: unknown;
  recommended?: unknown;
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  quotaInfo?: { remainingFraction?: unknown; resetTime?: unknown };
  disabled?: unknown;
  description?: unknown;
  isInternal?: unknown;
  tagTitle?: unknown;
}

interface CloudCodeFetchAvailableModelsResponse {
  models?: Record<string, CloudCodeModelDetails>;
  defaultAgentModelId?: unknown;
  agentModelSorts?: Array<{
    displayName?: unknown;
    groups?: Array<{ displayName?: unknown; modelIds?: unknown }>;
  }>;
}

// replica-local: a 5-minute cache of Cloud Code's model list per credential.
// Each replica may read a slightly different list; the picker only offers ids
// and a stale list cannot send a request or spend money, so no shared store is
// needed.
const modelListCache = new Map<string, { models: AntigravityModel[]; fetchedAt: number }>();
// replica-local: lookup of the live model definition for the current request.
// A resolver only reads this after its own fetch; other replicas do not need
// the same object, and a miss safely falls back to the curated catalog.
const dynamicModelsByKey = new Map<string, AntigravityModel>();

function staticModelFor(key: string): AntigravityModel | undefined {
  const lower = key.trim().toLowerCase();
  return ANTIGRAVITY_MODELS.find(
    (m) => m.id === key || m.resolved === key || m.name.toLowerCase() === lower,
  );
}

function mapCloudCodeBadge(
  tagTitle: unknown,
  unavailable: boolean,
  fallback?: AntigravityModel['badge'],
): AntigravityModel['badge'] {
  if (unavailable) return 'unavailable';
  const norm = typeof tagTitle === 'string' ? tagTitle.trim().toLowerCase() : '';
  if (norm === 'new') return 'new';
  if (norm === 'notice') return 'notice';
  if (norm === 'unavailable') return 'unavailable';
  return fallback;
}

function isCloudCodeUnavailable(details: CloudCodeModelDetails): boolean {
  if (details.disabled === true) return true;
  const tag = typeof details.tagTitle === 'string' ? details.tagTitle.trim().toLowerCase() : '';
  if (tag === 'unavailable') return true;
  if (typeof details.quotaInfo?.remainingFraction === 'number' && details.quotaInfo.remainingFraction <= 0) {
    return true;
  }
  return false;
}

function orderedCloudCodeModelIds(data: CloudCodeFetchAvailableModelsResponse): string[] {
  const models = data.models && typeof data.models === 'object' ? data.models : {};
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const sort of Array.isArray(data.agentModelSorts) ? data.agentModelSorts : []) {
    for (const group of Array.isArray(sort?.groups) ? sort.groups : []) {
      for (const id of Array.isArray(group?.modelIds) ? group.modelIds : []) {
        if (typeof id !== 'string' || seen.has(id) || !(id in models)) continue;
        if (models[id]?.isInternal === true) continue;
        seen.add(id);
        ordered.push(id);
      }
    }
  }

  for (const [id, details] of Object.entries(models)) {
    if (seen.has(id) || details?.isInternal === true) continue;
    seen.add(id);
    ordered.push(id);
  }

  return ordered;
}

/**
 * Normalizes a Cloud Code `/v1internal:fetchAvailableModels` response into Dosco
 * picker `AntigravityModel` entries, collapsing multi-effort variants into a
 * single selectable model with `efforts` while preserving standalone fixed
 * models (`GPT-OSS 120B (Medium)`, `Orchestrator (Argon)`).
 */
export function normalizeCloudCodeAvailableModels(raw: unknown): AntigravityModel[] {
  const data = (raw && typeof raw === 'object' ? raw : {}) as CloudCodeFetchAvailableModelsResponse;
  const models = data.models && typeof data.models === 'object' ? data.models : {};
  const orderedIds = orderedCloudCodeModelIds(data);
  if (orderedIds.length === 0) return [];

  // Count how many concrete variants exist per stripped base stem so standalone
  // fixed models like `gpt-oss-120b-medium` are not turned into an effort menu.
  const variantsByStem = new Map<string, string[]>();
  for (const rawId of orderedIds) {
    const stem = rawId.replace(EFFORT_SUFFIX_RE, '');
    const list = variantsByStem.get(stem) ?? [];
    list.push(rawId);
    variantsByStem.set(stem, list);
  }

  const normalized: AntigravityModel[] = [];
  const emittedStems = new Set<string>();
  const defaultAgentId = typeof data.defaultAgentModelId === 'string' ? data.defaultAgentModelId : '';

  for (const rawId of orderedIds) {
    const details = models[rawId];
    if (!details || typeof details !== 'object') continue;
    const match = rawId.match(EFFORT_SUFFIX_RE);
    const stem = rawId.replace(EFFORT_SUFFIX_RE, '');
    const groupIds = variantsByStem.get(stem) ?? [rawId];
    const isMultiVariant = !!match && groupIds.length > 1;

    if (isMultiVariant) {
      if (emittedStems.has(stem)) continue;
      emittedStems.add(stem);

      const fallback = staticModelFor(stem);
      const effortSet = new Set<AntigravityEffort>();
      let recommendedEffort: AntigravityEffort | undefined;
      let anyAvailable = false;
      let primaryDetails: CloudCodeModelDetails = details;

      for (const variantId of groupIds) {
        const variantDetails = models[variantId] ?? {};
        const suffix = variantId.match(EFFORT_SUFFIX_RE)?.[1];
        if (suffix && (EFFORT_ORDER as readonly string[]).includes(suffix)) {
          const effort = suffix as AntigravityEffort;
          effortSet.add(effort);
          if (variantId === defaultAgentId || variantDetails.recommended === true) {
            recommendedEffort = effort;
            primaryDetails = variantDetails;
          }
        }
        if (!isCloudCodeUnavailable(variantDetails)) anyAvailable = true;
      }

      const efforts = EFFORT_ORDER.filter((e) => effortSet.has(e));
      const unavailable = !anyAvailable;
      const defaultEffort = recommendedEffort
        ?? (fallback?.defaultEffort && effortSet.has(fallback.defaultEffort) ? fallback.defaultEffort : undefined)
        ?? (effortSet.has('medium') ? 'medium' : efforts[0]);
      const displayName = typeof primaryDetails.displayName === 'string' && primaryDetails.displayName.trim()
        ? primaryDetails.displayName.replace(EFFORT_DISPLAY_RE, '').trim()
        : fallback?.name ?? stem;

      normalized.push({
        id: fallback?.id ?? stem,
        name: displayName,
        resolved: stem,
        description:
          (typeof primaryDetails.description === 'string' && primaryDetails.description.trim())
          || fallback?.description
          || `${displayName} served via Google Antigravity`,
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(efforts.length ? { efforts } : {}),
        badge: mapCloudCodeBadge(primaryDetails.tagTitle, unavailable, fallback?.badge),
        ...(unavailable ? { unavailable: true } : {}),
        context:
          typeof primaryDetails.maxTokens === 'number' && primaryDetails.maxTokens > 0
            ? primaryDetails.maxTokens
            : (fallback?.context ?? 1_000_000),
        output:
          typeof primaryDetails.maxOutputTokens === 'number' && primaryDetails.maxOutputTokens > 0
            ? primaryDetails.maxOutputTokens
            : (fallback?.output ?? 64_000),
      });
      continue;
    }

    const fallback = staticModelFor(rawId) ?? staticModelFor(stem);
    const unavailable = isCloudCodeUnavailable(details);
    const displayName = typeof details.displayName === 'string' && details.displayName.trim()
      ? details.displayName.trim()
      : fallback?.name ?? rawId;
    const suffix = match?.[1];
    const singleEffort = suffix && suffix !== 'tiered' ? (suffix as AntigravityEffort) : undefined;
    // Keep standalone fixed-effort models (`GPT-OSS 120B (Medium)`) without redundant inline effort text.
    const includeDefaultEffort =
      fallback && !fallback.efforts
        ? fallback.defaultEffort
        : EFFORT_DISPLAY_RE.test(displayName)
          ? undefined
          : singleEffort ?? fallback?.defaultEffort;

    normalized.push({
      id: fallback?.id ?? rawId,
      name: displayName,
      resolved: rawId,
      description:
        (typeof details.description === 'string' && details.description.trim())
        || fallback?.description
        || `${displayName} served via Google Antigravity`,
      ...(includeDefaultEffort ? { defaultEffort: includeDefaultEffort } : {}),
      badge: mapCloudCodeBadge(details.tagTitle, unavailable, fallback?.badge),
      ...(unavailable ? { unavailable: true } : {}),
      context:
        typeof details.maxTokens === 'number' && details.maxTokens > 0
          ? details.maxTokens
          : (fallback?.context ?? 1_000_000),
      output:
        typeof details.maxOutputTokens === 'number' && details.maxOutputTokens > 0
          ? details.maxOutputTokens
          : (fallback?.output ?? 64_000),
    });
  }

  return normalized;
}

export interface CloudCodeModelQuotaWindow {
  /** Slug-safe model key for subscription usage windows (e.g. `gemini_4_neon`). */
  slug: string;
  /** Used share in 0-100 (`1 - remainingFraction`). */
  usedPercent: number;
  /** ISO reset timestamp when provided by Cloud Code, or null. */
  resetTime: string | null;
}

/**
 * Extracts per-model remaining quota fractions and reset timestamps from a
 * Cloud Code `/v1internal:fetchAvailableModels` response payload, ordered by
 * the curated `ANTIGRAVITY_MODELS` lineup (excluding unavailable placeholders
 * unless they report a real reset timestamp).
 */
export function extractCloudCodeModelQuotas(raw: unknown): CloudCodeModelQuotaWindow[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = raw as CloudCodeFetchAvailableModelsResponse;
  const models = data.models && typeof data.models === 'object' ? data.models : null;
  if (!models) return [];

  const orderedIds = orderedCloudCodeModelIds(data);
  const variantsByStem = new Map<string, string[]>();
  for (const rawId of orderedIds) {
    const stem = rawId.replace(EFFORT_SUFFIX_RE, '');
    const list = variantsByStem.get(stem) ?? [];
    list.push(rawId);
    variantsByStem.set(stem, list);
  }

  const emittedSlugs = new Set<string>();
  const quotasByCuratedId = new Map<string, CloudCodeModelQuotaWindow>();
  const extraQuotas: CloudCodeModelQuotaWindow[] = [];

  for (const [stem, groupIds] of variantsByStem) {
    const first = models[groupIds[0]!];
    if (!first || typeof first !== 'object') continue;
    const rawDisplay = typeof first.displayName === 'string'
      ? first.displayName.replace(EFFORT_DISPLAY_RE, '').trim()
      : '';
    const fallback = staticModelFor(stem) ?? (rawDisplay ? staticModelFor(rawDisplay) : undefined);

    let minRemaining: number | null = null;
    let resetTime: string | null = null;
    let anyDisabledOnly = true;

    for (const id of groupIds) {
      const details = models[id];
      if (!details || typeof details !== 'object') continue;
      if (details.disabled !== true) anyDisabledOnly = false;
      const frac = details.quotaInfo?.remainingFraction;
      if (typeof frac === 'number' && Number.isFinite(frac)) {
        const clamped = Math.min(1, Math.max(0, frac));
        minRemaining = minRemaining === null ? clamped : Math.min(minRemaining, clamped);
      }
      if (!resetTime && typeof details.quotaInfo?.resetTime === 'string' && details.quotaInfo.resetTime.trim()) {
        resetTime = details.quotaInfo.resetTime.trim();
      }
    }

    if (minRemaining === null) continue;
    if (anyDisabledOnly && !resetTime && fallback?.unavailable) continue;

    const rawKey = fallback?.id ?? stem;
    const slug = rawKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!slug || emittedSlugs.has(slug)) continue;
    emittedSlugs.add(slug);

    const usedPercent = Math.round((1 - minRemaining) * 1000) / 10;
    const entry: CloudCodeModelQuotaWindow = { slug, usedPercent, resetTime };
    if (fallback) {
      quotasByCuratedId.set(fallback.id, entry);
    } else {
      extraQuotas.push(entry);
    }
  }

  const ordered: CloudCodeModelQuotaWindow[] = [];
  for (const curated of ANTIGRAVITY_MODELS) {
    const hit = quotasByCuratedId.get(curated.id);
    if (hit) ordered.push(hit);
  }
  return [...ordered, ...extraQuotas];
}

/**
 * Restricts live Cloud Code model entries to the curated Antigravity
 * lineup in canonical order, merging live availability, efforts, and quota
 * signals onto each entry instead of letting raw Cloud Code aliases bloat the picker.
 */
export function selectCuratedAntigravityPickerModels(
  liveModels: readonly AntigravityModel[] | null | undefined,
): AntigravityModel[] {
  if (!liveModels?.length) return [...ANTIGRAVITY_MODELS];
  const liveByKey = new Map<string, AntigravityModel>();
  const liveByName = new Map<string, AntigravityModel>();
  for (const live of liveModels) {
    liveByKey.set(live.id, live);
    liveByKey.set(live.resolved, live);
    liveByName.set(live.name.trim().toLowerCase(), live);
  }
  return ANTIGRAVITY_MODELS.map((curated) => {
    // Claude's Antigravity ids are fixed strings. A live entry may report an
    // effort variant of one of them, but that variant is not a valid wire id.
    if (curated.pinWireId) return curated;
    const live =
      liveByKey.get(curated.id) ??
      liveByKey.get(curated.resolved) ??
      liveModels.find((m) => m.resolved.startsWith(`${curated.resolved}-`)) ??
      liveByName.get(curated.name.trim().toLowerCase());
    if (!live) return curated;
    const merged: AntigravityModel = {
      ...curated,
      resolved: live.resolved || curated.resolved,
      description: live.description || curated.description,
      efforts: live.efforts?.length ? live.efforts : curated.efforts,
      defaultEffort: live.defaultEffort ?? curated.defaultEffort,
      badge: live.badge ?? curated.badge,
      unavailable: live.unavailable ?? curated.unavailable,
      context: live.context || curated.context,
      output: live.output || curated.output,
    };
    if (merged.resolved !== curated.resolved) {
      dynamicModelsByKey.set(curated.id, merged);
    }
    return merged;
  });
}

/** Look up the most recently fetched live Cloud Code model definition by UI id or wire stem. */
export function lookupAntigravityDynamicModel(idOrResolved: string): AntigravityModel | undefined {
  return dynamicModelsByKey.get(idOrResolved);
}

export function __clearAntigravityModelsCacheForTest(): void {
  modelListCache.clear();
  dynamicModelsByKey.clear();
}

/**
 * Fetches live Antigravity models for a connected Google Cloud Code user via
 * `/v1internal:fetchAvailableModels`, caching per companion project for 5 min.
 */
export async function fetchAvailableAntigravityModels(
  accessToken: string,
  project?: string,
): Promise<AntigravityModel[] | null> {
  const cacheKey = project || '__default__';
  const cached = modelListCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const res = await fetch(`${CLOUDCODE_DAILY}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'user-agent': ANTIGRAVITY_HUB_USER_AGENT,
      },
      body: JSON.stringify(project ? { project } : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const models = normalizeCloudCodeAvailableModels(json);
    if (!models.length) return null;

    modelListCache.set(cacheKey, { models, fetchedAt: Date.now() });
    for (const entry of models) {
      dynamicModelsByKey.set(entry.id, entry);
      dynamicModelsByKey.set(entry.resolved, entry);
    }
    return models;
  } catch {
    return null;
  }
}

function extractCompanionProject(data: any): string | null {
  const p = data?.cloudaicompanionProject;
  if (typeof p === 'string' && p) return p;
  if (p && typeof p === 'object') {
    const id = p.id ?? p.projectId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

function pickOnboardingTier(loadJson: any): string {
  const tiers = Array.isArray(loadJson?.allowedTiers) ? loadJson.allowedTiers : [];
  const defaultTier = tiers.find((t: any) => t?.isDefault === true && typeof t?.id === 'string' && t.id);
  if (defaultTier) return defaultTier.id;
  const firstTier = tiers.find((t: any) => typeof t?.id === 'string' && t.id);
  if (firstTier) return firstTier.id;
  if (typeof loadJson?.currentTier?.id === 'string' && loadJson.currentTier.id) {
    return loadJson.currentTier.id;
  }
  return 'free-tier';
}

/**
 * Discovers the Cloud Code companion project via `loadCodeAssist`, falling back
 * to `onboardUser` provisioning (with LRO polling) when a user has not yet
 * been assigned a companion project.
 */
export async function discoverAntigravityProject(
  accessToken: string,
  opts?: { onboard?: boolean; pollDelayMs?: number },
): Promise<string | null> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': ANTIGRAVITY_HUB_USER_AGENT,
  };
  try {
    const res = await fetch(`${CLOUDCODE_DAILY}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata: CLOUDCODE_METADATA }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => ({}));
    const existing = extractCompanionProject(json);
    if (existing) return existing;

    if (opts?.onboard === false) return null;

    const tierId = pickOnboardingTier(json);
    const onboardRes = await fetch(`${CLOUDCODE_DAILY}/v1internal:onboardUser`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tierId, metadata: CLOUDCODE_METADATA }),
      signal: AbortSignal.timeout(8000),
    });
    if (!onboardRes.ok) return null;

    let op: any = await onboardRes.json().catch(() => ({}));
    const immediate = extractCompanionProject(op?.response);
    if (immediate) return immediate;

    const delayMs = opts?.pollDelayMs ?? 1000;
    for (let attempt = 0; attempt < 5 && !op?.done && typeof op?.name === 'string' && op.name; attempt++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const pollRes = await fetch(`${CLOUDCODE_DAILY}/v1internal/${op.name.replace(/^\/+/, '')}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'user-agent': ANTIGRAVITY_HUB_USER_AGENT,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!pollRes.ok) break;
      op = await pollRes.json().catch(() => ({}));
      const polled = extractCompanionProject(op?.response);
      if (polled) return polled;
    }

    return extractCompanionProject(op?.response);
  } catch {
    return null;
  }
}
