import { describe, test, expect } from 'bun:test';
import { createDb } from './client';

describe('createDb input validation', () => {
  test('throws when the database url is an empty string', () => {
    expect(() => createDb('')).toThrow('DATABASE_URL is required');
  });

  test('does not throw synchronously for a well-formed connection string', () => {
    expect(() => createDb('postgres://user:pass@127.0.0.1:5432/does_not_connect_lazily')).not.toThrow();
  });

  test('returns a drizzle database client object', () => {
    const client = createDb('postgres://user:pass@127.0.0.1:5432/lazy');
    expect(client).toBeDefined();
    expect(typeof client.select).toBe('function');
  });

  test('sends no GUC startup parameters (Supavisor transaction mode rejects them with 08P01)', () => {
    // Regression (2026-09-18): `connection: { statement_timeout }` failed
    // EVERY query through the pooler. Timeouts now live as role-level
    // defaults; only postgres.js's own application_name may remain.
    const client = createDb('postgres://user:pass@127.0.0.1:5432/lazy') as unknown as {
      $client?: { options?: { connection?: Record<string, unknown> } };
    };
    const connection = client.$client?.options?.connection ?? {};
    expect(connection.statement_timeout).toBeUndefined();
    expect(connection.lock_timeout).toBeUndefined();
  });
});
