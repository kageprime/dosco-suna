import { describe, expect, test } from 'bun:test';

import { SETTINGS_PANEL, settingsUrl, settingsWhere } from '../settings-path.ts';

// Characterization (KRTX-4813): pins the section link — including the strip of
// a web origin that ends in `/` — before settingsUrl reuses the shared helper.
describe('settingsUrl', () => {
  test('an origin ending in / loses the slash; the section path is appended once', () => {
    expect(settingsUrl('https://kortix.com/', 'ws_123', 'feature-flags')).toBe(
      'https://kortix.com/workspaces/ws_123/admin/feature-flags',
    );
  });

  test('a clean origin is used verbatim', () => {
    expect(settingsUrl('https://kortix.com', 'ws_123', 'general')).toBe(
      'https://kortix.com/workspaces/ws_123/admin/general',
    );
  });
});

describe('settingsWhere', () => {
  test('names the panel and the section label', () => {
    expect(settingsWhere('feature-flags')).toBe(`${SETTINGS_PANEL} → Feature flags`);
  });
});
