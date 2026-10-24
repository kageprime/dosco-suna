import { describe, expect, test } from 'bun:test';

// Production value on E2B Cloud: the API domain. Sandbox ingress is served on
// a different domain (`e2b.app`), which is the case this file pins.
process.env.E2B_DOMAIN = 'e2b.dev';

const { providerIngressTarget } = await import('./provider-redirect-follow');

const PORT_HOST = 'https://3000-x7k2m9q4z6c1v0b8n5j3.e2b.app/';

describe('providerIngressTarget', () => {
  test('follows a hop to the sandbox host when E2B_DOMAIN is the API domain', () => {
    expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.app/dashboard', PORT_HOST))
      .toBe('https://x7k2m9q4z6c1v0b8n5j3.e2b.app/dashboard');
  });

  test('follows a hop under the configured cluster domain', () => {
    expect(providerIngressTarget('e2b', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.dev/', PORT_HOST))
      .toBe('https://x7k2m9q4z6c1v0b8n5j3.e2b.dev/');
  });

  test('never follows an external host', () => {
    expect(providerIngressTarget('e2b', 'https://accounts.example.com/login', PORT_HOST)).toBeNull();
    expect(providerIngressTarget('e2b', 'https://e2b.app.example.com/', PORT_HOST)).toBeNull();
  });

  test('never trusts a one-label parent domain', () => {
    expect(providerIngressTarget('e2b', 'https://other.app/', 'https://3000-sbx.app/')).toBeNull();
  });

  test('relative Locations and other providers are the caller business', () => {
    expect(providerIngressTarget('e2b', '/dashboard', PORT_HOST)).toBeNull();
    expect(providerIngressTarget('daytona', 'https://x7k2m9q4z6c1v0b8n5j3.e2b.app/', PORT_HOST)).toBeNull();
  });
});
