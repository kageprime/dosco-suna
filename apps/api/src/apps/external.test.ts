import { expect, test } from 'bun:test';

import { allowsFraming } from './external';

const web = 'https://dosco.live';
const framed = (headers: Record<string, string>) => allowsFraming(new Headers(headers), web);

test('no framing headers: frameable', () => {
  expect(framed({})).toBe(true);
});

test('X-Frame-Options DENY and SAMEORIGIN refuse framing', () => {
  expect(framed({ 'x-frame-options': 'DENY' })).toBe(false);
  expect(framed({ 'x-frame-options': 'sameorigin' })).toBe(false);
});

test('CSP frame-ancestors decides and overrides X-Frame-Options', () => {
  expect(framed({ 'content-security-policy': "frame-ancestors 'none'" })).toBe(false);
  expect(framed({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" })).toBe(false);
  expect(framed({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' })).toBe(true);
  expect(framed({ 'content-security-policy': 'frame-ancestors https:' })).toBe(true);
  expect(framed({ 'content-security-policy': "frame-ancestors 'self' https://*.dosco.live" })).toBe(true);
  expect(framed({ 'content-security-policy': 'frame-ancestors https://dosco.live' })).toBe(true);
  expect(framed({ 'content-security-policy': 'frame-ancestors https://example.com' })).toBe(false);
  expect(framed({ 'content-security-policy': 'frame-ancestors http://dosco.live' })).toBe(false);
});

test('every CSP policy must allow it', () => {
  expect(framed({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" })).toBe(false);
});

test('a CSP without frame-ancestors falls back to X-Frame-Options', () => {
  expect(framed({ 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY' })).toBe(false);
  expect(framed({ 'content-security-policy': "default-src 'self'" })).toBe(true);
});
