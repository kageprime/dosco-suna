import { describe, expect, test } from 'bun:test';

import { sanitizeRedirectLocation } from './sanitize-redirect';

const SID = 'i8hku85asrc4vvdwh4hoo';
const RAW = `https://${SID}.e2b.dev`;
const RAW_PORT = `https://3000-${SID}.e2b.dev`;
const OPTS = { sandboxId: SID, currentPort: 3000 } as const;

describe('sanitizeRedirectLocation (same-sandbox provider hosts)', () => {
  test('relative locations keep the prefix', () => {
    expect(sanitizeRedirectLocation(RAW, '/login/callback?x=1', '/v1/p/x/3000', OPTS)).toBe(
      '/v1/p/x/3000/login/callback?x=1',
    );
  });

  test('exact upstream origin stays on the preview', () => {
    expect(sanitizeRedirectLocation(RAW, `${RAW}/a`, '', OPTS)).toBe('/a');
  });

  test('bare provider host folds to root-relative on the same port (origin form)', () => {
    expect(
      sanitizeRedirectLocation(`https://3000-${SID}.e2b.dev`, `${RAW}/oauth/cb`, '', {
        sandboxId: SID,
        currentPort: 3000,
      }),
    ).toBe('/oauth/cb');
  });

  test('port-prefixed variant folds to the path form with its port', () => {
    expect(sanitizeRedirectLocation(RAW, `${RAW_PORT}/app`, '/v1/p/x/3000', OPTS)).toBe(
      `/v1/p/${SID}/3000/app`,
    );
  });

  test('other-port variant maps to its own path entry, not the current port', () => {
    expect(
      sanitizeRedirectLocation(RAW, `https://5173-${SID}.e2b.dev/vite`, '/v1/p/x/3000', OPTS),
    ).toBe(`/v1/p/${SID}/5173/vite`);
  });

  test('explicit URL port wins over the hostname prefix', () => {
    expect(
      sanitizeRedirectLocation(RAW, `https://${SID}.e2b.dev:8443/s`, '/v1/p/x/3000', OPTS),
    ).toBe(`/v1/p/${SID}/8443/s`);
  });

  test('another sandbox id passes through (no open redirect collapse)', () => {
    const other = 'https://3000-aaaaaaaaaaaaaaaaaaaaaaaa.e2b.dev/evil';
    expect(sanitizeRedirectLocation(RAW, other, '/v1/p/x/3000', OPTS)).toBe(other);
  });

  test('genuinely external hosts pass through', () => {
    const ext = 'https://accounts.google.com/o/oauth2/auth?x=1';
    expect(sanitizeRedirectLocation(RAW, ext, '/v1/p/x/3000', OPTS)).toBe(ext);
  });

  test('without sandbox context the old behavior holds (escape preserved)', () => {
    expect(sanitizeRedirectLocation(RAW, `${RAW_PORT}/app`, '/v1/p/x/3000')).toBe(
      `${RAW_PORT}/app`,
    );
  });

  test('garbage stays null', () => {
    expect(sanitizeRedirectLocation(RAW, 'http://[::1', '/v1/p/x/3000', OPTS)).toBeNull();
  });
});
