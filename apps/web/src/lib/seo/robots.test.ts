import { expect, test } from 'bun:test';

import { renderRobotsTxt } from '@/lib/seo/robots';

// KRTX-3198: `Disallow: /_next/` also blocked /_next/static/, where every
// render-blocking stylesheet and script lives, so crawlers rendered pages
// without their CSS and JS. Crawlers apply the longest matching rule, so the
// static assets and optimized images are allowed and the rest stays blocked.
test('crawlers may fetch the static assets and images a page needs to render', () => {
  const robots = renderRobotsTxt('kortix.com');
  expect(robots).toContain('Allow: /_next/static/');
  expect(robots).toContain('Allow: /_next/image');
  expect(robots).toContain('Disallow: /_next/');
});

test('a non-canonical host still disallows everything', () => {
  expect(renderRobotsTxt('dev.kortix.com')).not.toContain('Allow: /_next/static/');
});

test('crawler directives do not enumerate private routes', () => {
  expect(renderRobotsTxt('kortix.com')).not.toContain('/admin');
});

// KRTX-4843: the hostname came from `host.split(':')[0]`, so an IPv6 loopback
// host (`[::1]:3000`) became `[` and local dev over IPv6 got the non-canonical
// policy. These pin the policy per host so the port strip keeps every
// domain and IPv4 result unchanged.
const CANONICAL = renderRobotsTxt('kortix.com');
const NON_CANONICAL = renderRobotsTxt('dev.kortix.com');

test('the canonical and local hosts serve the production policy', () => {
  expect(CANONICAL).toContain('Allow: /\n');
  expect(CANONICAL).toContain('Allow: /_next/static/');
  expect(CANONICAL).toContain('/sitemap.xml');
  expect(CANONICAL).toContain('/blog/sitemap.xml');
  for (const host of [
    'www.kortix.com',
    'KORTIX.com:443',
    'localhost:3000',
    'localhost',
    '127.0.0.1:3000',
    '[::1]:3000',
    '[::1]',
  ]) {
    expect(renderRobotsTxt(host), host).toBe(CANONICAL);
  }
});

test('every other host, a missing host and a malformed host disallow everything', () => {
  expect(NON_CANONICAL).toContain('Disallow: /\n');
  expect(NON_CANONICAL).not.toContain('Sitemap:');
  for (const host of [
    'staging.kortix.com',
    'seo-fix.vercel.app',
    'kortix.com.evil.test',
    null,
    '',
    'not a host',
    'a@kortix.com',
    'kortix.com/x',
    '[::1',
    '::1',
    '::2',
  ]) {
    expect(renderRobotsTxt(host), String(host)).toBe(NON_CANONICAL);
  }
});
