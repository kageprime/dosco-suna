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
    // The current EAS artifact — immutable per build.
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

describe('GET /download/mobile (the store QR code target)', () => {
  const scan = (userAgent: string) =>
    GET(new NextRequest(`${origin}/download/mobile`, { headers: { 'user-agent': userAgent } }), {
      params: Promise.resolve({ platform: 'mobile' }),
    });

  test('an Android phone lands on the APK download', async () => {
    const res = await scan('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('expo.dev/artifacts/eas/');
  });

  test('an iPhone lands on /download', async () => {
    const res = await scan('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${origin}/download`);
  });

  test('a desktop browser lands on /download', async () => {
    const res = await scan('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${origin}/download`);
  });
});
