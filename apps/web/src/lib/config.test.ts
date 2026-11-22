import { describe, expect, mock, test } from 'bun:test';

let mockEnv: {
  BILLING_ENABLED: boolean;
  MANAGED_PROVIDER_ENABLED?: boolean;
  RESTRICT_ACCOUNT_CREATION?: boolean;
  LOOPMAXXING_ENABLED?: boolean;
  LOOPMAXXING_ANNOUNCED?: boolean;
};

mock.module('@/lib/env-config', () => ({
  getEnv: () => mockEnv,
}));

const {
  isBillingEnabled,
  isManagedProviderEnabled,
  isAccountCreationRestricted,
  isLoopmaxxingEnabled,
  isLoopmaxxingAnnounced,
} = await import('./config');

describe('isBillingEnabled', () => {
  test('mirrors the runtime env BILLING_ENABLED flag', () => {
    mockEnv = { BILLING_ENABLED: true };
    expect(isBillingEnabled()).toBe(true);
    mockEnv = { BILLING_ENABLED: false };
    expect(isBillingEnabled()).toBe(false);
  });
});

describe('isManagedProviderEnabled', () => {
  test('CLOUD-ONLY: off by default (self-host), on only when Dosco Cloud sets it', () => {
    mockEnv = {
      BILLING_ENABLED: false,
      MANAGED_PROVIDER_ENABLED: false,
    };
    expect(isManagedProviderEnabled()).toBe(false);
    mockEnv = {
      BILLING_ENABLED: true,
      MANAGED_PROVIDER_ENABLED: true,
    };
    expect(isManagedProviderEnabled()).toBe(true);
  });
});

describe('isAccountCreationRestricted', () => {
  test('mirrors the runtime env RESTRICT_ACCOUNT_CREATION flag', () => {
    mockEnv = { BILLING_ENABLED: false, RESTRICT_ACCOUNT_CREATION: true };
    expect(isAccountCreationRestricted()).toBe(true);
    mockEnv = { BILLING_ENABLED: false, RESTRICT_ACCOUNT_CREATION: false };
    expect(isAccountCreationRestricted()).toBe(false);
  });
});

// A reachable page is not an announced one: the bar on the marketing site
// waits for its own flag, and never shows for a page that is off.
describe('isLoopmaxxingAnnounced', () => {
  test('the page can be on while the announcement stays off', () => {
    mockEnv = { BILLING_ENABLED: false, LOOPMAXXING_ENABLED: true, LOOPMAXXING_ANNOUNCED: false };
    expect(isLoopmaxxingEnabled()).toBe(true);
    expect(isLoopmaxxingAnnounced()).toBe(false);
  });

  test('announced needs the page on', () => {
    mockEnv = { BILLING_ENABLED: false, LOOPMAXXING_ENABLED: true, LOOPMAXXING_ANNOUNCED: true };
    expect(isLoopmaxxingAnnounced()).toBe(true);
    mockEnv = { BILLING_ENABLED: false, LOOPMAXXING_ENABLED: false, LOOPMAXXING_ANNOUNCED: true };
    expect(isLoopmaxxingAnnounced()).toBe(false);
  });
});
