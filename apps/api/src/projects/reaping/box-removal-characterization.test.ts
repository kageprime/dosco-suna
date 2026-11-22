/**
 * Characterization (KRTX-4928): the remove-then-confirm-gone ladder in
 * `attemptArchivedBoxRemoval` and `idleRetiredBoxRemoved`, and the archived-row
 * patch scaffold. Passes before and after both call the shared
 * `removeProviderBox` and `patchArchivedRow`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let removeError: Error | null = null;
let statusResult: string | Error = 'running';
const providerCalls: string[] = [];
let updates = 0;
let failFirstUpdate = false;

mock.module('../../platform/providers', () => ({
  isProviderName: () => true,
  getProvider: () => ({
    remove: async (id: string) => {
      providerCalls.push(`remove:${id}`);
      if (removeError) throw removeError;
    },
    getStatus: async (id: string) => {
      providerCalls.push(`status:${id}`);
      if (statusResult instanceof Error) throw statusResult;
      return statusResult;
    },
  }),
}));

const updateChain: Record<string, unknown> = {};
const chain = () =>
  new Proxy(updateChain, {
    get: (_t, prop) => {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if (failFirstUpdate && updates === 1) reject(new Error('db down'));
          else resolve(undefined);
        };
      }
      return () => chain();
    },
  });
const actualDb = await import('../../shared/db');
mock.module('../../shared/db', () => ({
  ...actualDb,
  db: { update: () => { updates += 1; return chain(); } },
}));

const { attemptArchivedBoxRemoval } = await import('./archived-box-removal');
const { idleRetiredBoxRemoved } = await import('./idle-volume-retire');

const row = { sandboxId: 'sb-1', externalId: 'ext-1', provider: 'platinum', metadata: null };
const retiredRow = {
  sandboxId: 'sb-1',
  metadata: { idleRetiredAt: 'x', ephemeralRetiredExternalId: 'ext-1' },
};

beforeEach(() => {
  removeError = null;
  statusResult = 'running';
  providerCalls.length = 0;
  updates = 0;
  failFirstUpdate = false;
});

describe('attemptArchivedBoxRemoval', () => {
  test('a stamp failure after a clean remove is a failed attempt, not a rejection', async () => {
    failFirstUpdate = true;
    expect(await attemptArchivedBoxRemoval(row)).toBe('failed');
    expect(providerCalls).toEqual(['remove:ext-1', 'status:ext-1']);
    expect(updates).toBe(2);
  });

  test('a stamp failure after a failed remove of a gone box is a rejection, not a failed attempt', async () => {
    removeError = new Error('404');
    statusResult = 'removed';
    failFirstUpdate = true;
    await expect(attemptArchivedBoxRemoval(row)).rejects.toThrow('db down');
    expect(providerCalls).toEqual(['remove:ext-1', 'status:ext-1']);
    expect(updates).toBe(1);
  });

  test('a clean remove stamps the row removed and never asks for status', async () => {
    expect(await attemptArchivedBoxRemoval(row)).toBe('removed');
    expect(providerCalls).toEqual(['remove:ext-1']);
    expect(updates).toBe(1);
  });

  test('a failed remove of a box the provider reports removed is a success', async () => {
    removeError = new Error('404');
    statusResult = 'removed';
    expect(await attemptArchivedBoxRemoval(row)).toBe('removed');
    expect(providerCalls).toEqual(['remove:ext-1', 'status:ext-1']);
    expect(updates).toBe(1);
  });

  test.each(['running', 'unknown', new Error('status down')])('a failed remove with status %p records the failure', async (status) => {
    removeError = new Error('boom');
    statusResult = status;
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await attemptArchivedBoxRemoval(row)).toBe('failed');
    } finally {
      console.warn = warn;
    }
    expect(updates).toBe(1);
  });

  test('a provider outside the allowed set is skipped untouched', async () => {
    expect(await attemptArchivedBoxRemoval({ ...row, provider: 'nope' })).toBe('skipped');
    expect(providerCalls).toEqual([]);
    expect(updates).toBe(0);
  });
});

describe('idleRetiredBoxRemoved', () => {
  test('a row that is not an idle retire, or is already removed, needs no provider call', async () => {
    expect(await idleRetiredBoxRemoved({ sandboxId: 's', metadata: {} })).toBe(true);
    expect(await idleRetiredBoxRemoved({ sandboxId: 's', metadata: { idleRetiredAt: 'x', providerRemovedAt: 'y' } })).toBe(true);
    expect(providerCalls).toEqual([]);
  });

  test('a clean remove stamps the row and reports gone', async () => {
    expect(await idleRetiredBoxRemoved(retiredRow)).toBe(true);
    expect(providerCalls).toEqual(['remove:ext-1']);
    expect(updates).toBe(1);
  });

  test('a failed remove of an already-gone box is gone', async () => {
    removeError = new Error('404');
    statusResult = 'removed';
    expect(await idleRetiredBoxRemoved(retiredRow)).toBe(true);
    expect(providerCalls).toEqual(['remove:ext-1', 'status:ext-1']);
  });

  test('a failed remove of a live box is not gone and stamps nothing', async () => {
    removeError = new Error('boom');
    expect(await idleRetiredBoxRemoved(retiredRow)).toBe(false);
    expect(updates).toBe(0);
  });
});
