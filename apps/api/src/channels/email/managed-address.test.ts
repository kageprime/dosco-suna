import { describe, expect, test } from 'bun:test';
import { managedInboxLocalPart, managedInboxSuffix } from './managed-address';

// Dev, staging and prod share one Resend team, so a managed address is one
// namespace across environments: a dev workspace once took hello@ on the
// managed domain. Generic and Kortix-owned names are reserved everywhere, and
// a non-prod environment marks its addresses with a `.<env>` suffix.
describe('managedInboxLocalPart', () => {
  test('the suffix the address form previews', () => {
    expect(managedInboxSuffix('prod')).toBe('');
    expect(managedInboxSuffix('dev')).toBe('.dev');
  });

  test('prod keeps the name as typed', () => {
    expect(managedInboxLocalPart('orders', 'prod')).toEqual({ localPart: 'orders' });
  });

  test('every non-prod environment adds a .<env> suffix', () => {
    expect(managedInboxLocalPart('orders', 'dev')).toEqual({ localPart: 'orders.dev' });
    expect(managedInboxLocalPart('orders', 'staging')).toEqual({ localPart: 'orders.staging' });
    expect(managedInboxLocalPart('orders', 'preview')).toEqual({ localPart: 'orders.preview' });
  });

  test('a name that already ends in the suffix is not doubled', () => {
    expect(managedInboxLocalPart('orders.dev', 'dev')).toEqual({ localPart: 'orders.dev' });
  });

  test('reserved names are refused in every environment, before and after the suffix', () => {
    for (const name of ['hello', 'support', 'admin', 'info', 'contact', 'team', 'sales', 'billing', 'security',
      'noreply', 'no-reply', 'postmaster', 'abuse', 'root', 'kortix', 'Hello', 'hello.dev']) {
      for (const env of ['prod', 'dev'] as const) {
        const result = managedInboxLocalPart(name, env);
        expect('error' in result).toBe(true);
      }
    }
  });

  test('a name that only contains a reserved word is allowed', () => {
    expect(managedInboxLocalPart('acme-support', 'prod')).toEqual({ localPart: 'acme-support' });
  });

  test('the suffixed name still fits the 48-character limit', () => {
    const result = managedInboxLocalPart('a'.repeat(48), 'staging');
    expect('localPart' in result && result.localPart.length).toBe(48);
    expect('localPart' in result && result.localPart.endsWith('.staging')).toBe(true);
  });
});
