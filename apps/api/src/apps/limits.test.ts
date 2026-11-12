import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  APP_MACHINE_LIMITS,
  AppLimitError,
  assertAppMachineWithinLimits,
  maxAppsForAccount,
  maxConcurrentAppRuntimes,
  assertAppQuotaAvailable,
  assertAppConcurrencyAvailable,
} from './limits';
import { appMonthlyEstimateUsd } from './cost';
import { appRuntimeImageKey } from './deployment-worker';
import { config } from '../config';

// The cap tests answer the tier from here; the real read is a database join.
const tier = { current: 'free' as string | null };
mock.module('../shared/account-limits', () => ({ resolveAccountTier: async () => tier.current }));

describe('App machine limits', () => {
  test('an App may not ask for a bigger machine than a session sandbox may', () => {
    // The App routes used to accept 64 CPU / 512 GB RAM / 2 TB disk while a
    // session snapshot was capped at 32 / 128 / 500 — and the App row was billed
    // for whatever it recorded. Apps now answer to the same ceiling.
    expect(APP_MACHINE_LIMITS.cpu.max).toBe(32);
    expect(APP_MACHINE_LIMITS.memory.max).toBe(128);
    expect(APP_MACHINE_LIMITS.disk.max).toBe(500);

    expect(() => assertAppMachineWithinLimits({ cpu: 32, memoryGb: 128, diskGb: 500 })).not.toThrow();
    expect(() => assertAppMachineWithinLimits({})).not.toThrow();
  });

  test('names the field, the bound, and what was asked for', () => {
    try {
      assertAppMachineWithinLimits({ cpu: 64 });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AppLimitError);
      const refusal = error as AppLimitError;
      expect(refusal.code).toBe('app_machine_out_of_range');
      expect(refusal.status).toBe(400);
      expect(refusal.detail).toMatchObject({ field: 'cpu', max: 32, requested: 64 });
    }
  });

  test('rejects every out-of-range dimension, including below the floor', () => {
    for (const machine of [
      { memoryGb: 512 },
      { diskGb: 2048 },
      { cpu: 0 },
      { memoryGb: 0 },
      { diskGb: 0 },
    ]) {
      expect(() => assertAppMachineWithinLimits(machine)).toThrow(AppLimitError);
    }
  });

});

describe('always-on cost', () => {
  const machine = { cpuCores: 1, memoryGb: 2, diskGb: 10 };

  test('the default machine costs about 40 USD for a month of 24/7 at list rates', () => {
    // 730 h × (1 × $0.0324 + 2 × $0.0108) + 10 GB × $0.0526 per month
    expect(appMonthlyEstimateUsd(machine)).toBe(39.95);
    expect(appMonthlyEstimateUsd({ cpuCores: 2, memoryGb: 4, diskGb: 20 })).toBe(79.89);
  });

});

describe('the App caps', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const overrides = ['KORTIX_APPS_MAX_PER_ACCOUNT', 'KORTIX_APPS_MAX_CONCURRENT_RUNTIMES'];

  afterEach(() => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = false;
    tier.current = 'free';
    for (const name of overrides) delete process.env[name];
  });

  test('with billing off both caps lift entirely, overrides included, and no account row is read', async () => {
    process.env.KORTIX_APPS_MAX_PER_ACCOUNT = '7';
    process.env.KORTIX_APPS_MAX_CONCURRENT_RUNTIMES = '9';
    expect(await maxAppsForAccount('account-1')).toBe(MAX);
    expect(await maxConcurrentAppRuntimes('account-1')).toBe(MAX);
    // No database in the unit lane: either call touching the count would throw.
    await assertAppQuotaAvailable('account-1');
    await assertAppConcurrencyAvailable('account-1');
  });

  test('a free account answers its tier appLimit for both caps', async () => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    expect(await maxAppsForAccount('account-1')).toBe(50);
    expect(await maxConcurrentAppRuntimes('account-1')).toBe(50);
  });

  test('Enterprise lifts the App count cap but not the runtime cap', async () => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    tier.current = 'enterprise';
    expect(await maxAppsForAccount('account-1')).toBe(MAX);
    expect(await maxConcurrentAppRuntimes('account-1')).toBe(5000);
  });

  test('an operator override wins over the tier and over Enterprise', async () => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    tier.current = 'enterprise';
    process.env.KORTIX_APPS_MAX_PER_ACCOUNT = '7';
    process.env.KORTIX_APPS_MAX_CONCURRENT_RUNTIMES = '9';
    expect(await maxAppsForAccount('account-1')).toBe(7);
    expect(await maxConcurrentAppRuntimes('account-1')).toBe(9);
  });

  test('an override that is not a positive integer is ignored', async () => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = true;
    process.env.KORTIX_APPS_MAX_PER_ACCOUNT = '0';
    process.env.KORTIX_APPS_MAX_CONCURRENT_RUNTIMES = '-3';
    expect(await maxAppsForAccount('account-1')).toBe(50);
    expect(await maxConcurrentAppRuntimes('account-1')).toBe(50);
  });
});

describe('runtime refresh key', () => {
  test('only the supervisor digest decides a refresh, not the API release', () => {
    expect(appRuntimeImageKey('0.13.52:appd-0123456789abcdef')).toBe('appd-0123456789abcdef');
    expect(appRuntimeImageKey('0.13.53:appd-0123456789abcdef')).toBe(appRuntimeImageKey('0.13.52:appd-0123456789abcdef'));
    expect(appRuntimeImageKey('0.13.53:appd-fedcba9876543210')).not.toBe(appRuntimeImageKey('0.13.52:appd-0123456789abcdef'));
    expect(appRuntimeImageKey('custom-override')).toBe('custom-override');
    expect(appRuntimeImageKey(null)).toBe('');
  });
});
