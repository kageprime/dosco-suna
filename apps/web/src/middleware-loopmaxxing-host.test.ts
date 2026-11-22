import { afterEach, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

// loopmaxxing.sh is the developer landing. Until the launch flag is on, the
// host shows nothing of its own: a visitor who finds the domain early lands on
// kortix.com. With the flag on, its root is the landing page, the setup guide
// is served under its own name (the copied prompt names it there) and every
// other path belongs to kortix.com.

const FLAG = 'KORTIX_PUBLIC_LOOPMAXXING_ENABLED';

function request(path: string): NextRequest {
  const req = new NextRequest(`https://loopmaxxing.sh${path}`);
  req.headers.set('host', 'loopmaxxing.sh');
  req.headers.set('x-forwarded-proto', 'https');
  return req;
}

afterEach(() => {
  delete process.env[FLAG];
});

test('before the launch every path of the host goes to kortix.com', async () => {
  for (const path of ['/', '/setup.md', '/pricing']) {
    const res = await middleware(request(path));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://kortix.com/');
  }
});

test('after the launch the root is the landing page and other pages are kortix.com', async () => {
  process.env[FLAG] = 'true';
  const root = await middleware(request('/'));
  expect(root.headers.get('x-middleware-rewrite')).toContain('/en/loopmaxxing');

  const pricing = await middleware(request('/pricing?ref=x'));
  expect(pricing.status).toBe(307);
  expect(pricing.headers.get('location')).toBe('https://kortix.com/pricing?ref=x');

  const own = await middleware(request('/loopmaxxing'));
  expect(own.status).toBe(308);
  expect(own.headers.get('location')).toBe('https://loopmaxxing.sh/');
});

test('after the launch the page reads its star count from the host itself', async () => {
  // A redirect to kortix.com would be cross-origin with no CORS header: the header's count would vanish.
  process.env[FLAG] = 'true';
  const res = await middleware(request('/api/github-stars'));
  expect(res.headers.get('location') ?? '').not.toContain('kortix.com');
});

test('after the launch the setup guide is served under the host itself', async () => {
  process.env[FLAG] = 'true';
  const res = await middleware(request('/setup.md'));
  expect(res.headers.get('location') ?? '').not.toContain('kortix.com');
});

test('after the launch the host serves its own robots.txt, sitemap and llms.txt', async () => {
  process.env[FLAG] = 'true';
  const robots = await middleware(request('/robots.txt'));
  expect(robots.headers.get('location') ?? '').not.toContain('kortix.com');
  for (const [path, file] of [
    ['/sitemap.xml', '/loopmaxxing-site/sitemap.xml'],
    ['/llms.txt', '/loopmaxxing-site/llms.txt'],
    ['/llms-full.txt', '/loopmaxxing-site/llms.txt'],
  ]) {
    const res = await middleware(request(path));
    expect(res.headers.get('x-middleware-rewrite')).toContain(file);
  }
});

function kortixRequest(path: string): NextRequest {
  const req = new NextRequest(`https://kortix.com${path}`);
  req.headers.set('host', 'kortix.com');
  req.headers.set('x-forwarded-proto', 'https');
  return req;
}

test('after the launch kortix.com/loopmaxxing and its locale copies move to loopmaxxing.sh', async () => {
  process.env[FLAG] = 'true';
  for (const path of ['/loopmaxxing', '/de/loopmaxxing', '/loopmaxxing/']) {
    const res = await middleware(kortixRequest(path));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://loopmaxxing.sh/');
  }
  // The wordmark sheet stays on kortix.com.
  const sheet = await middleware(kortixRequest('/loopmaxxing/wordmark'));
  expect(sheet.headers.get('location') ?? '').not.toContain('loopmaxxing.sh');
});

test('before the launch kortix.com/loopmaxxing is not redirected', async () => {
  const res = await middleware(kortixRequest('/loopmaxxing'));
  expect(res.headers.get('location') ?? '').not.toContain('loopmaxxing.sh');
});
