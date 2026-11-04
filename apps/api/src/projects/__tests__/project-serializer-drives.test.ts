import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { config } from '../../config';
import { featureFlagsEnvValue } from '../lib/feature-flag-env';
import { serializeProject } from '../lib/serializers';

describe('Project serializer and feature-flags drives gating without Platinum', () => {
  const origPlatinumKey = config.PLATINUM_API_KEY;
  const origSupabaseUrl = config.SUPABASE_URL;
  const origSupabaseKey = config.SUPABASE_SERVICE_ROLE_KEY;
  const origAllowedProviders = config.ALLOWED_SANDBOX_PROVIDERS;

  beforeEach(() => {
    (config as Record<string, unknown>).PLATINUM_API_KEY = undefined;
    (config as Record<string, unknown>).SUPABASE_URL = 'http://127.0.0.1:54321';
    (config as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    if (!config.ALLOWED_SANDBOX_PROVIDERS) {
      (config as Record<string, unknown>).ALLOWED_SANDBOX_PROVIDERS = ['platinum'];
    }
    if (typeof config.isProviderEnabled !== 'function') {
      (config as Record<string, unknown>).isProviderEnabled = () => true;
    }
  });

  afterEach(() => {
    (config as Record<string, unknown>).PLATINUM_API_KEY = origPlatinumKey;
    (config as Record<string, unknown>).SUPABASE_URL = origSupabaseUrl;
    (config as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY = origSupabaseKey;
    (config as Record<string, unknown>).ALLOWED_SANDBOX_PROVIDERS = origAllowedProviders;
  });

  test('featureFlagsEnvValue includes drives and volumes when Supabase is available without Platinum', () => {
    const flagsEnv = featureFlagsEnvValue({});
    expect(flagsEnv).toContain('drives');
    expect(flagsEnv).toContain('volumes');
    expect(flagsEnv).toContain('genui');
  });

  test('featureFlagsEnvValue omits drives and volumes when no storage is available', () => {
    (config as Record<string, unknown>).SUPABASE_URL = undefined;
    (config as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY = undefined;
    const flagsEnv = featureFlagsEnvValue({});
    expect(flagsEnv).not.toContain('drives');
    expect(flagsEnv).not.toContain('volumes');
    expect(flagsEnv).toContain('genui');
  });

  test('serializeProject serializes drives and volumes as true when Supabase is configured without Platinum', () => {
    const mockProject = {
      projectId: 'proj-123',
      accountId: 'acc-123',
      name: 'Test Project',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      storageUsed: 0,
    } as any;

    const serialized = serializeProject(mockProject);
    expect(serialized.experimental.drives).toBe(true);
    expect(serialized.experimental.volumes).toBe(true);
  });
});
