import { describe, expect, test } from 'bun:test';

import { resolveEmailLinkOrigin } from './email-link-origin';

// Regression (KRTX-4628): a signup's emailed verify link must return to the
// origin that started the flow — the PKCE verifier cookie and the resume
// snapshot are host-scoped, so a link that leaves the browsing origin (apex
// vs the configured www) lands where the jar is empty and a seconds-old
// confirmation dies on "The link is invalid or expired."

describe('resolveEmailLinkOrigin', () => {
  test('the browsing origin wins when it differs from the configured one only by www', () => {
    expect(resolveEmailLinkOrigin('https://kortix.com', 'https://www.kortix.com')).toBe('https://kortix.com');
  });

  test('the reverse www relation behaves the same', () => {
    expect(resolveEmailLinkOrigin('https://www.kortix.com', 'https://kortix.com')).toBe('https://www.kortix.com');
  });

  test('equal origins return the request origin', () => {
    expect(resolveEmailLinkOrigin('https://dev.kortix.com', 'https://dev.kortix.com')).toBe('https://dev.kortix.com');
  });

  test('a different site keeps the configured origin (preview deployments)', () => {
    expect(
      resolveEmailLinkOrigin('https://pr-1234.preview.kortix.com', 'https://dev.kortix.com'),
    ).toBe('https://dev.kortix.com');
  });

  test('an unrelated request origin cannot displace the configured origin', () => {
    expect(resolveEmailLinkOrigin('https://evil.example', 'https://www.kortix.com')).toBe('https://www.kortix.com');
  });

  test('without a configured origin the request origin stands', () => {
    expect(resolveEmailLinkOrigin('https://kortix.com', null)).toBe('https://kortix.com');
    expect(resolveEmailLinkOrigin('https://kortix.com', '')).toBe('https://kortix.com');
  });

  test('without either origin the historical localhost fallback stands', () => {
    expect(resolveEmailLinkOrigin(null, null)).toBe('http://localhost:3000');
  });

  test('a malformed configured origin (undecrypted ciphertext) does not throw', () => {
    expect(resolveEmailLinkOrigin('https://kortix.com', 'encrypted:abc123')).toBe('https://kortix.com');
    expect(resolveEmailLinkOrigin(null, 'encrypted:abc123')).toBe('http://localhost:3000');
  });

  test('a localhost port difference is NOT a same-site match (worktree isolation)', () => {
    // Two local frontends share the browser: the link must return to the
    // origin the browser actually browses (the verifier's jar), mirroring the
    // callback route's own request-origin-first preference for local dev.
    expect(resolveEmailLinkOrigin('http://localhost:13000', 'http://localhost:3000')).toBe('http://localhost:13000');
  });
});
