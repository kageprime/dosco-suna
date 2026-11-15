import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Badge } from './badge';

describe('Badge casing', () => {
  for (const variant of ['info', 'secondary', 'outline', 'muted'] as const) {
    test(`${variant} keeps the label's own case`, () => {
      const out = renderToStaticMarkup(<Badge variant={variant}>Environment variable</Badge>);
      expect(out).toMatch(/class="[^"]*\bnormal-case\b/);
    });
  }

  test('a warning badge opts into sentence case at its call site', () => {
    // The variant keeps the primitive's caps; the Secrets access labels pass
    // `normal-case` so they read as one set beside secondary and info.
    const out = renderToStaticMarkup(
      <Badge variant="warning" className="normal-case">
        Environment variable
      </Badge>,
    );
    expect(out).toMatch(/class="[^"]*\bnormal-case\b/);
  });
});
