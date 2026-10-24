import { describe, expect, test } from 'bun:test';

// Legacy E2B Cloud config value (`e2b.dev`): E2B's SDK derives `getHost()` from
// `domain`, so `baseUrl` is ALSO `*.e2b.dev`, and E2B's edge 308-redirects
// every browser navigation onto `*.e2b.app`.
process.env.E2B_DOMAIN = 'e2b.dev';

const { providerIngressTarget } = await import('./provider-redirect-follow');

const DEV_PORT_HOST = 'https://3000-x7k2m9q4z6c1v0b8n5j3.e2b.dev/';
const APP_PORT_HOST = 'https://3000-x7k2m9q4z6c1v0b8n5j3.e2b.app/';

describe('providerIngressTarget', () => {
  test('follows E2B Cloud .e2b.dev -> .e2b.app edge redirect when both baseUrl and E2B_DOMAIN are e2b.dev', () => {
    expect(providerIngressTarget('e2b', 'https://3000-x7k2m9q4z6c1v0b8n5j3.e2b.app/', DEV_PORT_HOST))
      .toBe('https://3000-x7k2m9q4z6c1v0b8n5j3.e2b.app/');
    expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.app/dashboard', DEV_PORT_HOST))
      .toBe('https://x7k2m9q4z6c1v0b8n5j3.e2b.app/dashboard');
  });

  test('follows a hop on .e2b.app or .e2b.dev', () => {
    expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.app/dashboard', APP_PORT_HOST))
      .toBe('https://x7k2m9q4z6c1v0b8n5j3.e2b.app/dashboard');
    expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.dev/', APP_PORT_HOST))
      .toBe('https://x7k2m9q4z6c1v0b8n5j3.e2b.dev/');
  });

  test('a self-hosted E2B cluster never trusts public E2B Cloud domains', async () => {
    const { config } = await import('../config');
    const prev = config.E2B_DOMAIN;
    (config as { E2B_DOMAIN: string }).E2B_DOMAIN = 'e2b.acme.internal';
    try {
      const selfHost = 'https://3000-x7k2m9q4z6c1v0b8n5j3.e2b.acme.internal/';
      expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.acme.internal/', selfHost))
        .toBe('https://x7k2m9q4z6c1v0b8n5j3.e2b.acme.internal/');
      expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.app/', selfHost)).toBeNull();
    } finally {
      (config as { E2B_DOMAIN: string }).E2B_DOMAIN = prev;
    }
  });

  test('never follows an external or look-alike host', () => {
    expect(providerIngressTarget('e2b', 'https://accounts.example.com/login', APP_PORT_HOST)).toBeNull();
    expect(providerIngressTarget('e2b', 'https://e2b.app.example.com/', APP_PORT_HOST)).toBeNull();
  });

  test('never trusts a one-label parent domain', () => {
    expect(providerIngressTarget('e2b', 'https://other.app/', 'https://3000-sbx.app/')).toBeNull();
  });

  test('relative Locations and other providers are the caller business', () => {
    expect(providerIngressTarget('e2b', '/dashboard', APP_PORT_HOST)).toBeNull();
    expect(providerIngressTarget('daytona', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.app/', APP_PORT_HOST)).toBeNull();
  });
});
