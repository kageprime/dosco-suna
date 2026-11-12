/**
 * The bundled-asset text reader: one read per module id across calls, and a
 * failed read retries on the next call. expo-asset and expo-file-system are stubs
 * that record every read.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

const downloads: number[] = [];
const files: { reads: string[]; fail: boolean } = { reads: [], fail: false };

mock.module('expo-asset', () => ({
  Asset: {
    fromModule: (id: number) => ({
      downloadAsync: async () => {
        downloads.push(id);
        return { localUri: `file:///${id}`, uri: '' };
      },
    }),
  },
}));
mock.module('expo-file-system', () => ({
  File: class {
    constructor(private uri: string) {}
    async text() {
      files.reads.push(this.uri);
      if (files.fail) throw new Error('read failed');
      return `text of ${this.uri}`;
    }
  },
}));

let loadBundledText: typeof import('./asset-text').loadBundledText;

beforeAll(async () => {
  ({ loadBundledText } = await import('./asset-text'));
});

afterEach(() => {
  files.fail = false;
  files.reads.length = 0;
  downloads.length = 0;
});

describe('loadBundledText', () => {
  test('one read per module id across two calls, sequential or concurrent', async () => {
    expect(await loadBundledText(7)).toBe('text of file:///7');
    expect(await loadBundledText(7)).toBe('text of file:///7');
    await Promise.all([loadBundledText(8), loadBundledText(8)]);
    expect(downloads).toEqual([7, 8]);
    expect(files.reads).toEqual(['file:///7', 'file:///8']);
  });

  test('different module ids read independently', async () => {
    await Promise.all([loadBundledText(1), loadBundledText(2)]);
    expect(downloads).toEqual([1, 2]);
  });

  test('a failed read retries on the next call', async () => {
    files.fail = true;
    await expect(loadBundledText(9)).rejects.toThrow('read failed');
    files.fail = false;
    expect(await loadBundledText(9)).toBe('text of file:///9');
    expect(downloads).toEqual([9, 9]);
  });
});
