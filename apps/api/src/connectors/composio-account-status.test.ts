/**
 * A Kortix revoke turns the Composio connected account off; activate turns it
 * back on. Composio answering "not found" means the account is already off.
 */
import { expect, test } from 'bun:test';
import { type ComposioRuntime, setComposioConnectedAccountEnabled } from './composio';

function runtime(fail?: Error): { runtime: ComposioRuntime; calls: string[] } {
  const calls: string[] = [];
  const record = (verb: string) => async (id: string) => {
    calls.push(`${verb} ${id}`);
    if (fail) throw fail;
    return {};
  };
  return {
    calls,
    runtime: {
      sessions: { create: async () => { throw new Error('unused'); }, use: async () => { throw new Error('unused'); } },
      connectedAccounts: { get: async () => null, disable: record('disable'), enable: record('enable') },
    } as ComposioRuntime,
  };
}

test('revoke disables the account and activate enables it', async () => {
  const fake = runtime();
  expect(await setComposioConnectedAccountEnabled('ca_synthetic1', false, fake.runtime)).toBe('done');
  expect(await setComposioConnectedAccountEnabled('ca_synthetic1', true, fake.runtime)).toBe('done');
  expect(fake.calls).toEqual(['disable ca_synthetic1', 'enable ca_synthetic1']);
});

test('an account Composio no longer has is gone, not an error', async () => {
  const fake = runtime(new Error('Connected account "ca_synthetic2" not found (404)'));
  expect(await setComposioConnectedAccountEnabled('ca_synthetic2', false, fake.runtime)).toBe('gone');
});

test('any other failure is reported and never thrown', async () => {
  const fake = runtime(new Error('socket hang up'));
  expect(await setComposioConnectedAccountEnabled('ca_synthetic3', false, fake.runtime)).toBe('failed');
});
