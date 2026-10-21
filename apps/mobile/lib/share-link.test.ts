import { describe, expect, test } from 'bun:test';
import { resolveShareLinkUrl } from './share-link';

describe('resolveShareLinkUrl', () => {
  test('keeps an https dosco.live share link as-is', () => {
    expect(resolveShareLinkUrl('https://dosco.live/share/abc')).toBe(
      'https://dosco.live/share/abc',
    );
  });

  test('preserves the www host and the query string', () => {
    expect(resolveShareLinkUrl('https://www.dosco.live/share/abc?x=1')).toBe(
      'https://www.dosco.live/share/abc?x=1',
    );
  });

  test('preserves staging, nested paths and the fragment', () => {
    expect(resolveShareLinkUrl('https://staging.dosco.live/share/session/tok?x=1#m2')).toBe(
      'https://staging.dosco.live/share/session/tok?x=1#m2',
    );
  });

  test('matches the host case-insensitively', () => {
    expect(resolveShareLinkUrl('https://dosco.live/share/abc')).toBe(
      'https://dosco.live/share/abc',
    );
  });

  test('maps the custom scheme onto dosco.live', () => {
    expect(resolveShareLinkUrl('dosco://share/abc')).toBe('https://dosco.live/share/abc');
    expect(resolveShareLinkUrl('dosco://share/abc?x=1')).toBe(
      'https://dosco.live/share/abc?x=1',
    );
    expect(resolveShareLinkUrl('dosco:///share/abc')).toBe('https://dosco.live/share/abc');
  });

  test('returns null for non-share links', () => {
    expect(resolveShareLinkUrl('https://dosco.live/auth/callback?mobile_callback=1')).toBeNull();
    expect(resolveShareLinkUrl('https://dosco.live/')).toBeNull();
    expect(resolveShareLinkUrl('https://dosco.live/shared/abc')).toBeNull();
    expect(resolveShareLinkUrl('dosco://auth/callback?code=1')).toBeNull();
    expect(resolveShareLinkUrl('dosco://connections')).toBeNull();
    expect(resolveShareLinkUrl('not a url')).toBeNull();
    expect(resolveShareLinkUrl('')).toBeNull();
  });

  test('returns null for a share path without an id', () => {
    expect(resolveShareLinkUrl('https://dosco.live/share')).toBeNull();
    expect(resolveShareLinkUrl('https://dosco.live/share/')).toBeNull();
    expect(resolveShareLinkUrl('dosco://share')).toBeNull();
    expect(resolveShareLinkUrl('dosco://share/')).toBeNull();
  });

  test('returns null for foreign hosts and schemes', () => {
    expect(resolveShareLinkUrl('https://evil.com/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('https://dosco.live.evil.com/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('https://user@dosco.live/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('http://dosco.live/share/abc')).toBeNull();
    expect(resolveShareLinkUrl('exp://127.0.0.1:8081/--/share/abc')).toBeNull();
  });
});
