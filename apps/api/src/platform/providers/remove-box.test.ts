import { describe, expect, test } from 'bun:test';
import type { SandboxProvider, SandboxStatus } from './contract';
import { removeProviderBox } from './remove-box';

/** A provider stub exposing only the two members `removeProviderBox` touches. */
function stub(
  remove: () => Promise<void>,
  getStatus: () => Promise<SandboxStatus>,
): Pick<SandboxProvider, 'remove' | 'getStatus'> {
  return { remove, getStatus };
}

describe('removeProviderBox', () => {
  test('a clean remove is removed and never asks for status', async () => {
    let asked = false;
    const out = await removeProviderBox(stub(async () => {}, async () => { asked = true; return 'running'; }), 'x');
    expect(out).toEqual({ removed: true, status: 'removed' });
    expect(asked).toBe(false);
  });

  test('a failed remove of a box the provider reports removed counts as removed, keeping the error', async () => {
    const err = new Error('404');
    const out = await removeProviderBox(stub(async () => { throw err; }, async () => 'removed'), 'x');
    expect(out).toEqual({ removed: true, status: 'removed', error: err });
  });

  test('a failed remove of a live box is not removed and reports the status', async () => {
    const err = new Error('boom');
    const out = await removeProviderBox(stub(async () => { throw err; }, async () => 'running'), 'x');
    expect(out).toEqual({ removed: false, status: 'running', error: err });
  });

  test('an unanswerable status is unknown, never removed', async () => {
    const err = new Error('boom');
    const out = await removeProviderBox(stub(async () => { throw err; }, async () => { throw new Error('down'); }), 'x');
    expect(out).toEqual({ removed: false, status: 'unknown', error: err });
  });
});
