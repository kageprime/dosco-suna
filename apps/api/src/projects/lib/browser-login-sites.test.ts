import { describe, expect, test } from 'bun:test';
import {
  BROWSER_LOGIN_MAX_SITES,
  decodeBrowserLogin,
  encodeBrowserLogin,
  loginPolicyFor,
  loginSiteAdmits,
  loginSitesOf,
  normalizeLoginSite,
  normalizeLoginSites,
  parseBrowserLoginInput,
} from './browser-login-sites';

describe('normalizeLoginSite', () => {
  test('a host or a URL becomes its exact lower-case host', () => {
    expect(normalizeLoginSite('App.Example.com')).toBe('app.example.com');
    expect(normalizeLoginSite('https://app.example.com/login?next=/')).toBe('app.example.com');
    expect(normalizeLoginSite('app.example.com/login')).toBe('app.example.com');
    expect(normalizeLoginSite('accounts.google.com.')).toBe('accounts.google.com');
    expect(normalizeLoginSite('localhost')).toBe('localhost');
    expect(normalizeLoginSite('127.0.0.1')).toBe('127.0.0.1');
    // Matching is by host, so a port names the same site.
    expect(normalizeLoginSite('http://localhost:8765')).toBe('localhost');
    expect(normalizeLoginSite('app.example.com:8443')).toBe('app.example.com');
  });

  test('wildcards, credentials, IPv6 and other schemes are refused', () => {
    for (const bad of [
      '*.example.com',
      'https://user:pw@app.example.com',
      '[::1]',
      'ftp://example.com',
      'javascript:alert(1)',
      'exa mple.com',
      '',
      '   ',
      'bad_host.example.com',
      '-lead.example.com',
      42,
      null,
    ]) {
      expect(normalizeLoginSite(bad)).toBeNull();
    }
  });
});

describe('normalizeLoginSites', () => {
  test('de-duplicates and keeps order', () => {
    expect(normalizeLoginSites(['b.example.com', 'https://A.example.com/x', 'b.example.com'])).toEqual({
      ok: true,
      sites: ['b.example.com', 'a.example.com'],
    });
    expect(normalizeLoginSites('app.example.com')).toEqual({ ok: true, sites: ['app.example.com'] });
  });

  test('an empty, missing, unusable or oversized list is an error', () => {
    expect(normalizeLoginSites(undefined).ok).toBe(false);
    expect(normalizeLoginSites([]).ok).toBe(false);
    expect(normalizeLoginSites(['ok.example.com', '*.example.com']).ok).toBe(false);
    const many = Array.from({ length: BROWSER_LOGIN_MAX_SITES + 1 }, (_, i) => `s${i}.example.com`);
    expect(normalizeLoginSites(many).ok).toBe(false);
  });
});

describe('loginSiteAdmits', () => {
  const sites = ['app.example.com', 'accounts.example.org'];

  test('admits a URL whose host is a site exactly', () => {
    expect(loginSiteAdmits(sites, 'https://app.example.com/login')).toBe(true);
    expect(loginSiteAdmits(sites, 'http://APP.example.com:8080/')).toBe(true);
    expect(loginSiteAdmits(sites, 'https://accounts.example.org/signin?continue=x')).toBe(true);
  });

  test('refuses subdomains, parents, lookalikes and non-http URLs', () => {
    for (const url of [
      'https://www.app.example.com/login',
      'https://example.com/login',
      'https://app.example.com.evil.test/login',
      'https://evil.test/?u=https://app.example.com',
      'https://app-example.com/',
      'file:///etc/passwd',
      'data:text/html,app.example.com',
      'not a url',
    ]) {
      expect(loginSiteAdmits(sites, url)).toBe(false);
    }
  });
});

describe('stored policy and value', () => {
  test('the policy round-trips its sites and drops malformed rules', () => {
    expect(loginSitesOf(loginPolicyFor(['a.example.com', 'b.example.com']))).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
    expect(loginSitesOf({ rules: [{ host: '*.evil.test' }, { host: 'ok.example.com' }] } as never)).toEqual([
      'ok.example.com',
    ]);
    expect(loginSitesOf(null)).toEqual([]);
    expect(loginSitesOf({ rules: 'nope' } as never)).toEqual([]);
  });

  test('a login round-trips, and a non-login value decodes to null', () => {
    const login = { username: 'ada@example.com', password: 'p"a\\ss word{}' };
    expect(decodeBrowserLogin(encodeBrowserLogin(login))).toEqual(login);
    expect(decodeBrowserLogin('sk-live-plain-api-key')).toBeNull();
    expect(decodeBrowserLogin('{"username":"a"}')).toBeNull();
    expect(decodeBrowserLogin('{"username":"","password":"x"}')).toBeNull();
    expect(decodeBrowserLogin('null')).toBeNull();
  });

  test('input keeps the password verbatim and trims only the username', () => {
    expect(parseBrowserLoginInput({ username: '  ada  ', password: ' spaced ' })).toEqual({
      ok: true,
      login: { username: 'ada', password: ' spaced ' },
    });
    expect(parseBrowserLoginInput({ username: 'ada', password: '' }).ok).toBe(false);
    expect(parseBrowserLoginInput({ username: ' ', password: 'x' }).ok).toBe(false);
    expect(parseBrowserLoginInput({ username: 'ada', password: 'x'.repeat(4097) }).ok).toBe(false);
    expect(parseBrowserLoginInput(null).ok).toBe(false);
  });
});
