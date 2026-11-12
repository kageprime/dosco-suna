import { describe, expect, test } from 'bun:test';
import { parseGenui } from '@kortix/sdk/genui';

import { MOBILE_EDGE_SAMPLES } from './debug-edge-samples';

describe('mobile edge samples', () => {
  for (const sample of MOBILE_EDGE_SAMPLES) {
    test(`${sample.title} parses with no issues, rooted at its component`, () => {
      const parsed = parseGenui(sample.source);
      expect(parsed.issues).toEqual([]);
      expect(JSON.stringify(parsed.root)).toContain(`"type":"${sample.component}"`);
    });
  }
});
