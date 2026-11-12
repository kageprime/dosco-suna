import { describe, expect, test } from 'bun:test';
import { CODEX_SEED_MODEL_IDS } from './codex-seed';

// The offline Codex lineup seed. The values refresh with the Codex CLI's own
// lineup (apps/api/scripts/refresh-codex-seed.ts, the catalog-refresh
// workflow), so these pins hold the shape the two consumers build from — the
// API's offline fallback (apps/api llm-gateway/models/codex-models.ts) and the
// sandbox agent server's local gateway picker (scripts/local.ts listModels) —
// never the lineup itself.
describe('codex seed', () => {
  test('is a non-empty list of unique model-id strings', () => {
    expect(CODEX_SEED_MODEL_IDS.length).toBeGreaterThan(0);
    for (const id of CODEX_SEED_MODEL_IDS) expect(typeof id).toBe('string');
    expect(new Set(CODEX_SEED_MODEL_IDS).size).toBe(CODEX_SEED_MODEL_IDS.length);
  });
});
