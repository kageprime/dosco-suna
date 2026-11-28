import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
mock.module('server-only', () => ({}));
const { GET } = await import('./route');

for (const suffix of ['', '?returnUrl=%2Fworkspaces&terms_accepted=true']) {
  test(`confirmation preserves callback pathname and parameters: ${suffix || 'no query'}`, () => {
    const target = `https://app.example.test/auth/callback${suffix}`;
    const query = new URLSearchParams({ redirect_to: target, token_hash: 'synthetic-hash' });
    const response = GET(new NextRequest(`https://app.example.test/auth/confirm?${query}`));
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/auth/callback');
    expect(location.searchParams.get('token_hash')).toBe('synthetic-hash');
    expect(location.searchParams.get('type')).toBe('signup');
    expect(location.searchParams.get('returnUrl')).toBe(suffix ? '/workspaces' : null);
  });
}

for (const target of ['https://other.example.test/auth/callback', 'kortix://auth/callback', 'https://app.example.test/dashboard', 'invalid']) {
  test(`rejects unsupported redirect: ${target}`, () => {
    const query = new URLSearchParams({ redirect_to: target, token_hash: 'synthetic-hash' });
    const response = GET(new NextRequest(`https://app.example.test/auth/confirm?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });
}

test('a configured www site preserves the originating apex callback', () => {
  const query = new URLSearchParams({ redirect_to: 'https://app.example.test/auth/callback', token_hash: 'synthetic-hash' });
  const response = GET(new NextRequest(`https://www.app.example.test/auth/confirm?${query}`));
  expect(new URL(response.headers.get('location') ?? '').origin).toBe('https://app.example.test');
});
