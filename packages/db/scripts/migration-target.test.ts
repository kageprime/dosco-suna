import { describe, expect, test } from 'bun:test';
import {
  assertBootstrapTargetAllowed,
  migrationCheckOrder,
  migrationBootstrapsPrerequisites,
} from './migration-target';

describe('migration target mode', () => {
  test('keeps migration ordering strict for normal commands', () => {
    expect(migrationCheckOrder('up', 'postgresql://user:pass@db.example.com/app')).toBe(true);
    expect(migrationCheckOrder('status', 'postgresql://user:pass@127.0.0.1:5432/app')).toBe(true);
  });

  test('allows out-of-order migrations only for a loopback local-up target', () => {
    expect(migrationCheckOrder('local-up', 'postgresql://user:pass@127.0.0.1:5432/app')).toBe(false);
    expect(migrationCheckOrder('local-up', 'postgresql://user:pass@localhost:5432/app')).toBe(false);
  });

  test('rejects local-up for remote and invalid database URLs', () => {
    expect(() => migrationCheckOrder('local-up', 'postgresql://user:pass@db.example.com/app')).toThrow(
      'local-up refuses non-loopback database host: db.example.com',
    );
    expect(() => migrationCheckOrder('local-up', 'not-a-url')).toThrow(
      'local-up requires a valid loopback DATABASE_URL',
    );
  });

  test('allows preview-up only inside the preview database network', () => {
    expect(migrationCheckOrder('preview-up', 'postgresql://user:pass@supabase-db:5432/app', '1')).toBe(false);
    expect(() => migrationCheckOrder('preview-up', 'postgresql://user:pass@supabase-db:5432/app')).toThrow();
    expect(() => migrationCheckOrder('preview-up', 'postgresql://user:pass@db.example.com/app', '1')).toThrow();
    expect(() => migrationCheckOrder('preview-up', 'postgresql://user:pass@127.0.0.1:5432/app', '1')).toThrow();
  });

  test('bootstraps platform prerequisites for fresh local and self-host databases', () => {
    expect(migrationBootstrapsPrerequisites('local-up')).toBe(true);
    expect(migrationBootstrapsPrerequisites('preview-up')).toBe(true);
    expect(migrationBootstrapsPrerequisites('bootstrap')).toBe(true);
    expect(migrationBootstrapsPrerequisites('up')).toBe(false);
    expect(migrationBootstrapsPrerequisites('status')).toBe(false);
  });

  test('bootstrap/local-up run on loopback and the self-host Compose database', () => {
    for (const host of ['127.0.0.1:5432', 'localhost:5432', 'supabase-db:5432']) {
      expect(() =>
        assertBootstrapTargetAllowed('bootstrap', `postgresql://postgres:pw@${host}/postgres`),
      ).not.toThrow();
    }
    expect(() =>
      assertBootstrapTargetAllowed('local-up', 'postgresql://postgres:pw@127.0.0.1:5432/postgres'),
    ).not.toThrow();
  });

  test('bootstrap/local-up refuse managed/provisioned targets without --allow-remote', () => {
    for (const host of ['aws-0-eu-west-1.pooler.supabase.com', 'db.abcdefgh.supabase.co', 'db.example.com']) {
      expect(() =>
        assertBootstrapTargetAllowed('bootstrap', `postgresql://postgres:pw@${host}:5432/postgres`),
      ).toThrow(`bootstrap refuses remote database host: ${host}`);
      expect(() =>
        assertBootstrapTargetAllowed('local-up', `postgresql://postgres:pw@${host}:5432/postgres`),
      ).toThrow('refuses remote database host');
    }
  });

  test('bootstrap allows a remote target with --allow-remote, and ignores other commands', () => {
    const cloud = 'postgresql://postgres:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
    expect(() => assertBootstrapTargetAllowed('bootstrap', cloud, ['--allow-remote'])).not.toThrow();
    expect(() => assertBootstrapTargetAllowed('up', cloud)).not.toThrow();
    expect(() => assertBootstrapTargetAllowed('status', cloud)).not.toThrow();
    expect(() => assertBootstrapTargetAllowed('bootstrap', 'not-a-url')).toThrow(
      'bootstrap requires a valid DATABASE_URL',
    );
  });
});
