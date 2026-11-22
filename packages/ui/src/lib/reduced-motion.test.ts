import { expect, test } from 'bun:test';

// A test that stubs `document` without an <html> element (a partial DOM) loads
// this module through @kortix/ui. The module seeds Motion's flag at load: it
// must read that document as "switch off", not throw.
test('a document without <html> reads as off instead of throwing at load', async () => {
  const saved = globalThis.document;
  Object.assign(globalThis, { document: {} });
  try {
    const { prefersReducedMotion } = await import('./reduced-motion');
    expect(prefersReducedMotion()).toBe(false);
  } finally {
    Object.assign(globalThis, { document: saved });
  }
});
