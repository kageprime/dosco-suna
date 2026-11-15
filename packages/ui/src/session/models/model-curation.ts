import type { FlatModel } from '@kortix/sdk/react';

import { isClaudeSubscriptionModel, isSubscriptionModel, pickerModelName, shouldShowFreeTag } from './model-tags';

export const CURATED_PRIMARY_LIMIT = 5;

export interface ModelSubtitleStrings {
  freeFast: string;
  freeGeneral: string;
  reasoning: string;
  fast: string;
  balanced: string;
  general: string;
}

const FAST_MODEL_RE = /\b(flash|haiku|mini|lite|nano|fast|turbo|instant)\b/i;
const FLAGSHIP_MODEL_RE = /\b(opus|pro|ultra|max|heavy|reasoner|gpt-5|o3|o4|r1|sonnet)\b/i;
const EFFORT_PREFERENCE: Readonly<Record<string, number>> = {
  medium: 0,
  high: 1,
  '': 2,
  low: 3,
  minimal: 4,
  xhigh: 5,
  extra: 5,
  max: 6,
};

const modelIdentityKey = (model: Pick<FlatModel, 'providerID' | 'modelID'>) =>
  `${model.providerID}:${model.modelID}`;

const sameModel = (
  a: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined,
  b: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined,
) => !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;

/** Normalized display name used to collapse twin/variant rows in the compact primary menu. */
export function modelDisplayKey(model: Pick<FlatModel, 'providerID' | 'modelID' | 'modelName' | 'provider'>): string {
  return pickerModelName(model).trim().toLowerCase();
}

function effortRank(effort: string | undefined): number {
  if (!effort) return EFFORT_PREFERENCE['']!;
  return EFFORT_PREFERENCE[effort.toLowerCase()] ?? 4;
}

function winnerRank(
  model: FlatModel,
  ctx: {
    selected: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined;
    accountDefault: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined;
    isFavorite: (m: Pick<FlatModel, 'providerID' | 'modelID'>) => boolean;
  },
): [number, number, number, number, number] {
  const isSel = sameModel(model, ctx.selected) ? 0 : 1;
  const isFav = ctx.isFavorite(model) ? 0 : 1;
  const isDef = sameModel(model, ctx.accountDefault) ? 0 : 1;
  const isAvail = model.available !== false && !model.unavailable ? 0 : 1;
  const eff = effortRank(model.defaultEffort);
  return [isSel, isFav, isDef, isAvail, eff];
}

function compareTuples(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

function curationScore(
  model: FlatModel,
  ctx: {
    selected: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined;
    accountDefault: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined;
    isFavorite: (m: Pick<FlatModel, 'providerID' | 'modelID'>) => boolean;
  },
): number {
  let score = 0;
  if (model.available === false || model.unavailable) score -= 1000;
  if (ctx.isFavorite(model)) score += 200;
  if (sameModel(model, ctx.accountDefault)) score += 150;
  if (model.providerID === 'kortix' && !isSubscriptionModel(model)) score += 60;
  if (isClaudeSubscriptionModel(model) || isSubscriptionModel(model)) score += 50;
  if (shouldShowFreeTag(model)) score += 45;
  if (FLAGSHIP_MODEL_RE.test(model.modelName) || FLAGSHIP_MODEL_RE.test(model.modelID)) score += 35;
  if (model.capabilities?.reasoning) score += 20;
  if (FAST_MODEL_RE.test(model.modelName) || FAST_MODEL_RE.test(model.modelID)) score += 15;
  if (sameModel(model, ctx.selected)) score += 10;
  return score;
}

/**
 * Curates a compact, duplicate-free set of models for the popover's primary view.
 *
 * Guarantees the currently selected model is visible (even when chosen via search),
 * keeps starred favorites and the workspace default near the top, deduplicates twin
 * names (such as multi-effort Antigravity variants), and caps the list cleanly so
 * the full catalog stays one click away under "More models".
 */
export function curatePrimaryModels(input: {
  browseModels: readonly FlatModel[];
  pickableModels: readonly FlatModel[];
  selected: Pick<FlatModel, 'providerID' | 'modelID'> | null | undefined;
  accountDefault?: Pick<FlatModel, 'providerID' | 'modelID'> | null;
  isFavorite: (m: Pick<FlatModel, 'providerID' | 'modelID'>) => boolean;
  limit?: number;
}): FlatModel[] {
  const limit = input.limit ?? CURATED_PRIMARY_LIMIT;
  const ctx = {
    selected: input.selected,
    accountDefault: input.accountDefault,
    isFavorite: input.isFavorite,
  };

  // Merge browseModels + favorites/selected from pickableModels without duplicating keys.
  const byKey = new Map<string, FlatModel>();
  for (const m of input.browseModels) {
    byKey.set(modelIdentityKey(m), m);
  }
  for (const m of input.pickableModels) {
    const k = modelIdentityKey(m);
    if (!byKey.has(k) && (ctx.isFavorite(m) || sameModel(m, ctx.selected))) {
      byKey.set(k, m);
    }
  }

  // Deduplicate by normalized display name so primary rows never repeat the same label.
  const byName = new Map<string, FlatModel>();
  for (const m of byKey.values()) {
    const nameKey = modelDisplayKey(m);
    const existing = byName.get(nameKey);
    if (!existing) {
      byName.set(nameKey, m);
      continue;
    }
    const cmp = compareTuples(winnerRank(m, ctx), winnerRank(existing, ctx));
    if (cmp < 0 || (cmp === 0 && m.providerID === 'kortix' && existing.providerID !== 'kortix')) {
      byName.set(nameKey, m);
    }
  }

  const deduped = Array.from(byName.values());
  if (deduped.length <= limit) {
    return deduped;
  }

  // Score and preserve a calm, predictable order instead of yanking rows on click.
  const ranked = [...deduped].sort((a, b) => {
    const diff = curationScore(b, ctx) - curationScore(a, ctx);
    if (diff !== 0) return diff;
    return pickerModelName(a).localeCompare(pickerModelName(b));
  });

  const picked = ranked.slice(0, limit);
  if (ctx.selected) {
    const selectedWinner = deduped.find((m) => sameModel(m, ctx.selected));
    if (selectedWinner && !picked.some((m) => sameModel(m, selectedWinner))) {
      // Replace the lowest-priority filler item that is not a favorite/default.
      let replaceIdx = picked.length - 1;
      for (let i = picked.length - 1; i >= 0; i--) {
        const candidate = picked[i]!;
        if (!ctx.isFavorite(candidate) && !sameModel(candidate, ctx.accountDefault)) {
          replaceIdx = i;
          break;
        }
      }
      picked[replaceIdx] = selectedWinner;
    }
  }

  // Re-sort the curated slice alphabetically/naturally with favorites & defaults anchored
  // gently so the list feels stable across selections (no jumping when you click row 3).
  return picked.sort((a, b) => {
    const aPin = ctx.isFavorite(a) || sameModel(a, ctx.accountDefault) ? 0 : 1;
    const bPin = ctx.isFavorite(b) || sameModel(b, ctx.accountDefault) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    return pickerModelName(a).localeCompare(pickerModelName(b));
  });
}

/**
 * Formats a concise 1-line subtitle for the primary model menu. Prefers the first
 * clean sentence of `model.description` when present, falling back to factual traits.
 */
export function modelSubtitle(model: FlatModel, strings: ModelSubtitleStrings): string {
  const raw = (model.description ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length > 0 && raw.toLowerCase() !== 'kortix gateway') {
    const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] ?? raw;
    if (firstSentence.length <= 76) {
      return firstSentence.replace(/\.$/, '');
    }
    const clipped = firstSentence.slice(0, 72);
    const lastSpace = clipped.lastIndexOf(' ');
    return `${(lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trim()}…`;
  }

  const nameAndId = `${model.modelName} ${model.modelID}`;
  const isFast = FAST_MODEL_RE.test(nameAndId);
  if (shouldShowFreeTag(model)) {
    return isFast ? strings.freeFast : strings.freeGeneral;
  }
  if (isFast) return strings.fast;
  if (FLAGSHIP_MODEL_RE.test(nameAndId) && !/\bsonnet\b/i.test(nameAndId)) {
    return strings.reasoning;
  }
  if (model.capabilities?.reasoning || /\bsonnet\b/i.test(nameAndId)) {
    return strings.balanced;
  }
  return strings.general;
}
