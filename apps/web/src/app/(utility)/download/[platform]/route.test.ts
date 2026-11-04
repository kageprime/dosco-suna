import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

const origin = 'https://dosco.live';
// GitHub is stubbed: the suite asserts the redirect, not GitHub's latency. A
// live call timed out the packages and core lanes at bun's 5 s default.
const realFetch = globalThis.fetch;
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/kortix-ai/CompanyOS/releases/download/v1.0.0/${name}`,
  size: 1,
});
const release = {
  tag_name: 'v1.0.0',
  assets: [asset('Kortix-1.0.0-universal.dmg'), asset('Kortix-Setup-1.0.0.exe'), asset('Kortix-1.0.0-x86_64.AppImage')],
};
let githubFetch: typeof fetch;
beforeEach(() => {
  githubFetch = (async () => Response.json(release)) as unknown as typeof fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => githubFetch(input, init)) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

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

describe('GET /download/<platform> per deployment', () => {
  const withBackend = async (backend: string, run: () => Promise<void>) => {
    const saved = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = backend;
    try {
      await run();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_BACKEND_URL;
      else process.env.NEXT_PUBLIC_BACKEND_URL = saved;
    }
  };

  for (const channel of ['dev', 'staging'] as const) {
    test(`the ${channel} deployment serves the newest desktop-${channel}-latest build`, async () => {
      const urls: string[] = [];
      githubFetch = (async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return Response.json({
          tag_name: `desktop-${channel}-latest`,
          assets: [asset('Kortix-0.9.83-universal.dmg'), asset('Kortix.Dev-0.14.3-universal.dmg'), asset('Kortix.Dev-0.13.51-universal.dmg')],
        });
      }) as unknown as typeof fetch;
      await withBackend(`https://${channel}-api.kortix.com/v1`, async () => {
        const res = await call('macos');
        expect(res.headers.get('location') ?? '').toEndWith('/Kortix.Dev-0.14.3-universal.dmg');
        expect(urls).toEqual([`https://api.github.com/repos/kortix-ai/CompanyOS/releases/tags/desktop-${channel}-latest`]);
      });
    });

    test(`the ${channel} deployment never falls back to the production installer`, async () => {
      githubFetch = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
      await withBackend(`https://${channel}-api.kortix.com/v1`, async () => {
        const res = await call('windows');
        expect(res.headers.get('location')).toBe(`https://github.com/kortix-ai/CompanyOS/releases/tag/desktop-${channel}-latest`);
      });
    });
  }

  test('production serves the latest vX.Y.Z release', async () => {
    const urls: string[] = [];
    githubFetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json(release);
    }) as unknown as typeof fetch;
    await withBackend('https://api.kortix.com/v1', async () => {
      expect((await call('linux')).headers.get('location') ?? '').toEndWith('/Kortix-1.0.0-x86_64.AppImage');
      expect(urls).toEqual(['https://api.github.com/repos/kortix-ai/CompanyOS/releases/latest']);
    });
  });
});
