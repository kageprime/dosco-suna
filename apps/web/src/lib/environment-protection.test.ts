import { describe, expect, test } from 'bun:test';

import {
  ENVIRONMENT_ACCESS_COOKIE,
  ENVIRONMENT_HEALTH_PATH,
  ENVIRONMENT_PROTECTION_USERNAME,
  authorizeEnvironment,
  deriveEnvironmentAccessCookie,
} from './environment-protection';

function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

describe('authorizeEnvironment', () => {
  test('allows all requests when protection is disabled', () => {
    expect(
      authorizeEnvironment({
        enabled: 'false',
        password: undefined,
        authorization: null,
        pathname: '/',
      }),
    ).toEqual({ allowed: true, source: 'disabled' });
  });

  test('always allows the ECS health path', () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: undefined,
        authorization: null,
        pathname: ENVIRONMENT_HEALTH_PATH,
      }),
    ).toEqual({ allowed: true, source: 'health' });
  });

  test('always allows security.txt so the disclosure policy stays reachable (RFC 9116)', () => {
    for (const password of ['test-password', undefined]) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password,
          authorization: null,
          pathname: '/.well-known/security.txt',
        }),
      ).toEqual({ allowed: true, source: 'security-txt' });
    }
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: null,
        pathname: '/.well-known/other.txt',
      }),
    ).toEqual({ allowed: false, reason: 'credentials_required' });
  });

  test('fails closed when protection is enabled without a password', () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: undefined,
        authorization: null,
        pathname: '/',
      }),
    ).toEqual({ allowed: false, reason: 'configuration_error' });
  });

  test('always allows the Supabase auth callback routes', () => {
    // The verify→callback hop is a cross-site top-level redirect whose request
    // can arrive without the access cookie; a gate 401 there consumes the
    // single-use code and the sign-in link is burned with no session. The
    // routes carry their own boundary (PKCE code + browser-held verifier), so
    // the environment gate adds nothing on them.
    for (const pathname of ['/auth/callback', '/auth/mobile/callback']) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization: null,
          pathname,
        }),
      ).toEqual({ allowed: true, source: 'auth-callback' });
    }
  });

  test('exempts exactly the auth callback routes, not lookalike paths', () => {
    for (const pathname of [
      '/auth/callbackx',
      '/auth/callback/extra',
      '/auth',
      '/auth/signup',
      '/workspaces',
    ]) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization: null,
          pathname,
        }),
      ).toEqual({ allowed: false, reason: 'credentials_required' });
    }
  });

  test('always allows the setup guide, the loop guides and the installer', () => {
    // The prompt copied on a gated deployment tells a coding agent to curl
    // these: a 401 stops the setup at its first step.
    for (const pathname of ['/setup.md', '/factory.md', '/install', '/install.sh', '/loops/software-factory.md']) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization: null,
          pathname,
        }),
      ).toEqual({ allowed: true, source: 'setup-guide' });
    }
  });

  test('exempts exactly the setup files, not pages beside them', () => {
    for (const pathname of ['/setup', '/setup.md/x', '/installer', '/loops', '/loops/software-factory', '/loopmaxxing', '/docs/setup.md']) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization: null,
          pathname,
        }),
      ).toEqual({ allowed: false, reason: 'credentials_required' });
    }
  });

  test('rejects missing and malformed credentials', () => {
    for (const authorization of [null, 'Bearer token', 'Basic not-base64%%%']) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization,
          pathname: '/',
        }),
      ).toEqual({ allowed: false, reason: 'credentials_required' });
    }
  });

  test('rejects a wrong username or password', () => {
    for (const authorization of [
      basic('other', 'test-password'),
      basic(ENVIRONMENT_PROTECTION_USERNAME, 'wrong-password'),
    ]) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization,
          pathname: '/workspaces',
        }),
      ).toEqual({ allowed: false, reason: 'credentials_required' });
    }
  });

  test('accepts the configured username and password', () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: basic(ENVIRONMENT_PROTECTION_USERNAME, 'test-password'),
        pathname: '/workspaces',
      }),
    ).toEqual({ allowed: true, source: 'basic' });
  });

  test('accepts one signed parent-domain cookie across protected subdomains', async () => {
    const expectedAccessCookie = await deriveEnvironmentAccessCookie('test-password');
    expect(expectedAccessCookie).not.toContain('test-password');
    expect(ENVIRONMENT_ACCESS_COOKIE).toBe('__Secure-kortix_test_access');
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: null,
        accessCookie: expectedAccessCookie,
        expectedAccessCookie,
        pathname: '/workspaces',
      }),
    ).toEqual({ allowed: true, source: 'cookie' });
  });

  test('rejects a cookie derived from another password', async () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: null,
        accessCookie: await deriveEnvironmentAccessCookie('wrong-password'),
        expectedAccessCookie: await deriveEnvironmentAccessCookie('test-password'),
        pathname: '/workspaces',
      }),
    ).toEqual({ allowed: false, reason: 'credentials_required' });
  });
});
