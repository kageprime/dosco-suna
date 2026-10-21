import { describe, expect, test } from 'bun:test';

import { IN_APP_BROWSER_OPTIONS, httpHost, linkTarget } from './link-target';

describe('linkTarget', () => {
  test('opens every http(s) link in the in-app browser (KRTX-2104)', () => {
    expect(linkTarget('https://dosco.live')).toBe('in-app');
    expect(linkTarget('https://docs.dosco.live/sdk')).toBe('in-app');
    expect(linkTarget('HTTPS://DOCS.dosco.live/')).toBe('in-app');
    expect(linkTarget('  https://dosco.live/legal  ')).toBe('in-app');
    // Third-party hosts: an App's URL, GitHub, a markdown link, a sandbox preview.
    expect(linkTarget('https://my-app.example.dev/?token=x')).toBe('in-app');
    expect(linkTarget('https://github.com/acme/repo')).toBe('in-app');
    expect(linkTarget('http://localhost:3000/x')).toBe('in-app');
    expect(linkTarget('https://dosco.live@evil.example/x')).toBe('in-app');
  });

  test('returns null for non-web links and malformed input', () => {
    expect(linkTarget('mailto:support@dosco.live')).toBeNull();
    expect(linkTarget('tel:+15550100')).toBeNull();
    expect(linkTarget('dosco://share/abc')).toBeNull();
    expect(linkTarget('ftp://dosco.live')).toBeNull();
    expect(linkTarget('dosco.live')).toBeNull();
    expect(linkTarget('https://')).toBeNull();
    expect(linkTarget('')).toBeNull();
  });
});

describe('IN_APP_BROWSER_OPTIONS', () => {
  test('keeps the Android Custom Tab inside the Kortix task', () => {
    // `createTask: true` (the expo-web-browser default) opens the tab as its
    // own entry in Android Recents, which reads as leaving the app.
    expect(IN_APP_BROWSER_OPTIONS.createTask).toBe(false);
  });
});

describe('httpHost', () => {
  test('strips userinfo, port, and a trailing dot, and lowercases', () => {
    expect(httpHost('https://User@Docs.dosco.live:8443/a')).toBe('docs.dosco.live');
    expect(httpHost('https://dosco.live./a')).toBe('dosco.live');
    expect(httpHost('http://127.0.0.1:8008/v1')).toBe('127.0.0.1');
  });
});
