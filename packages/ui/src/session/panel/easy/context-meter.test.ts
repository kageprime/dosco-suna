import { describe, expect, test } from 'bun:test';

import { findModelKey, offersCompact } from './context-meter';

const models = [
  { providerID: 'kortix', modelID: 'codex/gpt-6.1-sol' },
  { providerID: 'kortix', modelID: 'claude/opus' },
];

describe('findModelKey', () => {
  test('the session row key (with provider prefix) resolves', () => {
    expect(findModelKey(models, 'kortix/codex/gpt-6.1-sol')).toEqual(models[0]);
  });

  test("the gateway's served model (no provider prefix) resolves to the same entry", () => {
    expect(findModelKey(models, 'codex/gpt-6.1-sol')).toEqual(models[0]);
  });

  test('an unknown or missing key resolves to nothing, so no window is invented', () => {
    expect(findModelKey(models, 'codex/unknown')).toBeNull();
    expect(findModelKey(models, null)).toBeNull();
  });
});

describe('offersCompact', () => {
  test('from the warning tone, when the runtime can compact', () => {
    expect(offersCompact({ limit: 500_000, tone: 'warning' }, true)).toBe(true);
    expect(offersCompact({ limit: 500_000, tone: 'destructive' }, true)).toBe(true);
  });

  test('never under 70%, on a runtime that cannot compact, or without a known window', () => {
    expect(offersCompact({ limit: 500_000, tone: 'info' }, true)).toBe(false);
    expect(offersCompact({ limit: 500_000, tone: 'destructive' }, false)).toBe(false);
    expect(offersCompact({ limit: null, tone: 'destructive' }, true)).toBe(false);
  });
});
