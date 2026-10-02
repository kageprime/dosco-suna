/**
 * Config-object completeness (regression: 2nd upstream sync dropped the
 * PAYSTACK_* + E2B_WEBHOOK_SECRET mappings from the exported `config`
 * object while the Zod schema kept parsing them — boot stayed green and
 * every runtime read got `undefined`).
 *
 * Every envSchema key must exist on `config`, except keys intentionally
 * read straight from process.env (documented below).
 */
import { describe, expect, test } from 'bun:test';
import { config, envSchema } from '../config';

// Read directly from process.env by design (generated at boot or consumed
// before config hydration); never expected on the config object.
const PROCESS_ENV_DIRECT = new Set([
  'INTERNAL_SERVICE_KEY',
  'SANDBOX_VERSION',
  'BETTERSTACK_API_LOG_TOKEN',
  'BETTERSTACK_API_LOG_HOST',
  'BETTERSTACK_API_SENTRY_DSN',
]);

describe('config object completeness', () => {
  test('every schema key is mapped onto config', () => {
    const schemaKeys = Object.keys(envSchema.shape);
    const missing = schemaKeys.filter(
      (k) => !PROCESS_ENV_DIRECT.has(k) && !(k in (config as Record<string, unknown>)),
    );
    expect(missing).toEqual([]);
  });

  test('billing + webhook secrets survive (the Sept 2026 incident)', () => {
    const c = config as Record<string, unknown>;
    for (const k of [
      'PAYSTACK_API_URL',
      'PAYSTACK_PUBLIC_KEY',
      'PAYSTACK_SECRET_KEY',
      'PAYSTACK_WEBHOOK_SECRET',
      'PAYSTACK_USD_NGN_RATE',
      'E2B_WEBHOOK_SECRET',
    ]) {
      expect(k in c, `${k} mapped`).toBe(true);
    }
  });
});
