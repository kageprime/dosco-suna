import { providerAuthRequirement } from '@kortix/llm-catalog/lite';
import type { LlmProviderEntry, ProjectSecret } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// KRTX-5026: the sheet's "Save key" wrote the key and said "saved" before any
// provider check, so a mistyped OpenRouter key failed every turn unexplained.
// The write now answers with the provider's verdict (`verification`).
let verification: ProjectSecret['verification'] = null;
const toasts: string[] = [];

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  upsertProjectSecret: async (projectId: string, input: { name: string }): Promise<ProjectSecret> => ({
    identifier: input.name, name: input.name, project_id: projectId, secret_id: null,
    created_by: null, created_at: null, updated_at: null, configured: true, mine: null,
    effective_source: 'shared', can_manage_shared: true, verification,
  }),
}));
mock.module('../../primitives/toast', () => ({
  successToast: (message: string) => toasts.push(`success:${message}`),
  errorToast: (message: string) => toasts.push(`error:${message}`),
}));
const i18n = await import('../../i18n');
mock.module('../../i18n', () => ({
  ...i18n,
  useTranslations: (namespace: string) =>
    Object.assign(
      (key: string, values?: Record<string, string>) => `${namespace}.${key}${values ? ` ${JSON.stringify(values)}` : ''}`,
      { raw: (key: string) => `${namespace}.${key}` },
    ),
}));

const { useProviderKey } = await import('./provider-sheet');

const OPENROUTER: LlmProviderEntry = {
  id: 'openrouter', label: 'OpenRouter', envVars: ['OPENROUTER_API_KEY'],
  authRequirement: providerAuthRequirement({ id: 'openrouter', env: ['OPENROUTER_API_KEY'] }),
  helpUrl: null, apiHost: null, hint: '', models: [], featured: false,
};

/** Type a key and press Save; return what `save()` answered and the field's error. */
async function saveKey() {
  let key = null as ReturnType<typeof useProviderKey> | null;
  function Probe() {
    key = useProviderKey('synthetic-project', OPENROUTER);
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => key!.setValue('OPENROUTER_API_KEY', 'sk-or-v1-not-a-key'));
  let saved: boolean | undefined;
  await act(async () => {
    saved = await key!.save();
  });
  return { saved, error: key!.error, values: key!.values };
}

beforeEach(() => {
  verification = null;
  toasts.length = 0;
});

describe('useProviderKey — the save reports the provider check', () => {
  test('a key the provider refuses fails the save with the provider words, and the field keeps it', async () => {
    verification = { status: 'invalid', message: 'User not found.', checked_at: '2026-11-20T00:00:00.000Z' };
    const { saved, error, values } = await saveKey();
    const refused = 'pooledSecrets.savedInvalid {"provider":"OpenRouter","message":"User not found."}';
    expect(saved).toBe(false);
    expect(error).toBe(refused);
    expect(values).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-not-a-key' });
    expect(toasts).toEqual([`error:${refused}`]);
  });

  test('a verified key saves and clears the field', async () => {
    verification = { status: 'verified', message: 'The provider accepted the key.', checked_at: '2026-11-20T00:00:00.000Z' };
    const { saved, error, values } = await saveKey();
    expect(saved).toBe(true);
    expect(error).toBeNull();
    expect(values).toEqual({});
    expect(toasts).toEqual(['success:hardcodedUi.i18nComplete.textbc8686cf8d63 {"value0":"OpenRouter"}']);
  });

  test('a check with no answer (unknown) or none at all still saves', async () => {
    verification = { status: 'unknown', message: 'Verification timed out.', checked_at: '2026-11-20T00:00:00.000Z' };
    expect((await saveKey()).saved).toBe(true);
    verification = null;
    expect((await saveKey()).saved).toBe(true);
  });
});
