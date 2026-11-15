import { describe, expect, test } from 'bun:test';

import { findModelKey } from './context-meter';

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
