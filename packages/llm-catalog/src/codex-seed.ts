import codexSeedJson from './codex-models.seed.json' with { type: 'json' };

// Offline fallback only. Regenerate: `bun apps/api/scripts/refresh-codex-seed.ts`
// (the weekly catalog-refresh workflow does).
export const CODEX_SEED_MODEL_IDS: readonly string[] = codexSeedJson;
