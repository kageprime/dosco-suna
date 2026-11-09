import { describe, expect, test } from 'bun:test';

import { openPastedText, usePastedTextStore } from './pasted-text-store';

// Characterization: pins the pasted-text store's behavior across the
// interface-unexport cleanup (a type-level change with no runtime effect).
describe('pasted-text store', () => {
  test('starts closed', () => {
    expect(usePastedTextStore.getState().text).toBeNull();
  });

  test('open() shows the paste text and close() clears it', () => {
    usePastedTextStore.getState().open('hello');
    expect(usePastedTextStore.getState().text).toBe('hello');
    usePastedTextStore.getState().close();
    expect(usePastedTextStore.getState().text).toBeNull();
  });

  test('openPastedText routes a paste through the store', () => {
    openPastedText({ text: 'pasted body' });
    expect(usePastedTextStore.getState().text).toBe('pasted body');
    usePastedTextStore.getState().close();
    expect(usePastedTextStore.getState().text).toBeNull();
  });
});
