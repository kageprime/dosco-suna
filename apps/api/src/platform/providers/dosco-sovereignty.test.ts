/**
 * Dosco Sovereignty Guard
 *
 * Fast (<50ms) regression test that guards Dosco's sovereign platform architecture
 * against accidental deletions, Platinum-locking, or regressions during upstream
 * syncs and automated refactors.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock test env before importing config
process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:54322/postgres';
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.API_KEY_SECRET = 'test-api-key-secret';
process.env.TUNNEL_SIGNING_SECRET = 'test-tunnel-signing-secret';
process.env.ALLOWED_SANDBOX_PROVIDERS = 'e2b';
process.env.E2B_API_KEY = 'e2b_test_key';
process.env.PLATINUM_API_KEY = 'pt_test_key';
process.env.DAYTONA_API_KEY = 'daytona_test_key';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.PLATINUM_INFERENCE_URL = 'https://inference.example.com';
process.env.KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT = 'https://s3.example.com';

const SRC_ROOT = join(import.meta.dirname, '..', '..');
const API_ROOT = join(SRC_ROOT, '..');
const REPO_ROOT = join(API_ROOT, '..', '..');

const { KNOWN_PROVIDERS, config } = await import('../../config');
const { getProvider } = await import('./index');
const { getSandboxProvider } = await import('../../snapshots/providers');
const { driveStorageAvailable } = await import('../../drives/volumes');

describe('Dosco sovereignty invariants', () => {
  describe('sandbox provider sovereignty (E2B for Heroku)', () => {
    test('KNOWN_PROVIDERS must include e2b', () => {
      expect(KNOWN_PROVIDERS).toContain('e2b');
    });

    test('E2B provider and snapshot files must exist on disk', () => {
      const e2bProviderPath = join(SRC_ROOT, 'platform', 'providers', 'e2b.ts');
      const e2bDomainPath = join(SRC_ROOT, 'platform', 'providers', 'e2b-domain.ts');
      const e2bSnapshotPath = join(SRC_ROOT, 'snapshots', 'providers', 'e2b.ts');

      expect(existsSync(e2bProviderPath)).toBe(true);
      expect(existsSync(e2bDomainPath)).toBe(true);
      expect(existsSync(e2bSnapshotPath)).toBe(true);
    });

    test('E2B is resolvable through the runtime provider registry', () => {
      const provider = getProvider('e2b');
      expect(provider).toBeDefined();
      expect(provider.name).toBe('e2b');
    });

    test('E2B is registered in the snapshot adapter registry', () => {
      const adapter = getSandboxProvider('e2b');
      expect(adapter).toBeDefined();
      expect(adapter.id).toBe('e2b');
    });
  });

  describe('storage sovereignty (Supabase Storage Provider)', () => {
    test('Supabase storage provider files must exist', () => {
      const providerInterface = join(SRC_ROOT, 'drives', 'storage', 'contract.ts');
      const supabaseStorage = join(SRC_ROOT, 'drives', 'storage', 'supabase.ts');

      expect(existsSync(providerInterface)).toBe(true);
      expect(existsSync(supabaseStorage)).toBe(true);
    });

    test('driveStorageAvailable returns true when Supabase is configured without Platinum', () => {
      // In test env, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
      expect(driveStorageAvailable()).toBe(true);
    });

    test('project serializers do not lock drives/volumes to isPlatinumConfigured', () => {
      const serializersPath = join(SRC_ROOT, 'projects', 'lib', 'serializers.ts');
      const content = readFileSync(serializersPath, 'utf8');

      // The serializer must use driveStorageAvailable()
      expect(content).toContain('driveStorageAvailable');
      // Neither volumes nor drives field should be hardcoded to isPlatinumConfigured()
      expect(content).not.toMatch(/volumes:\s*isPlatinumConfigured\(\)/);
      expect(content).not.toMatch(/drives:\s*isPlatinumConfigured\(\)/);
    });
  });

  describe('deployment sovereignty (Dockerfile.heroku)', () => {
    test('Dockerfile.heroku exists at repo root and has correct Bun version', () => {
      const dockerfilePath = join(REPO_ROOT, 'Dockerfile.heroku');
      expect(existsSync(dockerfilePath)).toBe(true);

      const content = readFileSync(dockerfilePath, 'utf8');
      expect(content).toContain('ARG SANDBOX_AGENT_BUN_VERSION=1.4.3');
      expect(content).toContain('packages/voice/src');
    });
  });

  describe('agent rules sovereignty (AGENTS.md)', () => {
    test('AGENTS.md includes the Dosco Sovereign Architecture section', () => {
      const agentsMdPath = join(REPO_ROOT, 'AGENTS.md');
      expect(existsSync(agentsMdPath)).toBe(true);

      const content = readFileSync(agentsMdPath, 'utf8');
      expect(content).toContain('## Dosco Sovereign Architecture: Protected Surfaces Against Upstream Divergence');
      expect(content).toContain('apps/api/src/platform/providers/e2b.ts');
      expect(content).toContain('Supabase Storage');
      expect(content).toContain('The Orc');
    });
  });
});
