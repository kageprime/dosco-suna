import { afterAll, expect, test } from 'bun:test';
import { accounts, projects, accountModelPreferences } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { deleteAccountModelPreference, getAccountModelDefaults, upsertAccountModelPreference } from './model-preferences';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const otherProjectId = crypto.randomUUID();

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('clearing a retired agent suppresses legacy fallback durably in only that project', async () => {
  await db.insert(accounts).values({ accountId, name: 'model-clear-test' });
  await db.insert(projects).values([
    { accountId, projectId, splitPending: true, name: 'model-clear-test', repoUrl: 'file:///tmp/model-clear-test.git' },
    { accountId, projectId: otherProjectId, splitPending: true, name: 'model-clear-other', repoUrl: 'file:///tmp/model-clear-other.git' },
  ]);
  await db.insert(accountModelPreferences).values([
    { accountId, scope: 'account', scopeKey: '', model: 'account-model' },
    { accountId, scope: 'project', scopeKey: projectId, model: 'project-model' },
    { accountId, scope: 'agent', scopeKey: 'retired', model: 'legacy-model' },
    { accountId, scope: 'agent', scopeKey: 'unrelated', projectId, model: 'other-model' },
  ]);
  const target = { accountId, scope: 'agent', scopeKey: 'retired', projectId } satisfies Parameters<typeof deleteAccountModelPreference>[0];
  expect((await getAccountModelDefaults(accountId, projectId)).agents.retired).toBe('legacy-model');
  await deleteAccountModelPreference(target);
  expect((await getAccountModelDefaults(accountId, projectId)).agents).not.toHaveProperty('retired');
  await upsertAccountModelPreference({ ...target, model: 'replacement-model' });
  expect((await getAccountModelDefaults(accountId, projectId)).agents.retired).toBe('replacement-model');
  for (let attempt = 0; attempt < 2; attempt++) {
    await deleteAccountModelPreference(target);
    expect(await getAccountModelDefaults(accountId, projectId)).toEqual({
      account: 'account-model', projects: { [projectId]: 'project-model' }, agents: { unrelated: 'other-model' },
    });
    expect((await getAccountModelDefaults(accountId, otherProjectId)).agents.retired).toBe('legacy-model');
    expect((await getAccountModelDefaults(accountId)).agents.retired).toBe('legacy-model');
  }
  await upsertAccountModelPreference({ ...target, model: 'repinned-model' });
  expect((await getAccountModelDefaults(accountId, projectId)).agents.retired).toBe('repinned-model');
  await deleteAccountModelPreference(target);
  await upsertAccountModelPreference({ ...target, model: 'seed-model', onlyIfAbsent: true });
  expect((await getAccountModelDefaults(accountId, projectId)).agents).not.toHaveProperty('retired');
});
