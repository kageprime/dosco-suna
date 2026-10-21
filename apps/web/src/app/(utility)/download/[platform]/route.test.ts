import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

const origin = 'https://dosco.live';
const call = (platform: string) =>
  GET(new NextRequest(`${origin}/download/${platform}`), {
    params: Promise.resolve({ platform }),
  });

describe('GET /download/<platform>', () => {
  test('serves Android the installable APK, never a desktop installer', async () => {
    const res = await call('android');
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    // The current EAS artifact (mobile-store-urls.ts) — immutable per build.
    expect(location).toContain('expo.dev/artifacts/eas/');
  });

  test('sends iOS to the download page — there is no Dosco iOS build', async () => {
    for (const alias of ['ios', 'iphone', 'ipad']) {
      const res = await call(alias);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${origin}/download`);
    }
  });

  test('sends desktop to the download page — no Dosco desktop build yet', async () => {
    for (const platform of ['macos', 'windows', 'linux', 'mac', 'win', 'solaris']) {
      const res = await call(platform);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${origin}/download`);
    }
  });
});
