import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, chatInstalls, projectSecrets, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { decryptChannelSecret, deleteProjectSecrets, listProjectsForWorkspace, readSecret, upsertSecret } from './install-store';
import { loadSlackInstall, saveSlackInstall } from './slack/installs';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const otherProjectId = crypto.randomUUID();
const ownerUserId = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'synthetic-install-secrets' });
  await db.insert(projects).values([projectId, otherProjectId].map((id) => ({
    projectId: id, accountId, name: 'synthetic-install', splitPending: true,
    repoUrl: `file:///nonexistent/${id}.git`,
  })));
});

afterAll(async () => {
  for (const id of [projectId, otherProjectId]) {
    await db.delete(chatInstalls).where(eq(chatInstalls.projectId, id));
    await db.delete(projectSecrets).where(eq(projectSecrets.projectId, id));
  }
  await db.delete(projects).where(eq(projects.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

async function rows(id: string, name: string) {
  return db.select().from(projectSecrets).where(and(eq(projectSecrets.projectId, id), eq(projectSecrets.name, name)));
}

describe('shared channel secrets on migrated PostgreSQL', () => {
  test('update scopes to the project and ownerless row and restores connector delivery', async () => {
    await upsertSecret(projectId, 'SYNTHETIC_TOKEN', 'first');
    await upsertSecret(otherProjectId, 'SYNTHETIC_TOKEN', 'other-project');
    await db.insert(projectSecrets).values({
      projectId, identifier: 'personal-synthetic-token', name: 'SYNTHETIC_TOKEN', ownerUserId,
      valueEnc: 'personal-unchanged', scope: 'runtime', strategy: 'runtime', consumer: 'sandbox',
    });
    await db.update(projectSecrets).set({ active: false, scope: 'runtime', strategy: 'runtime', consumer: 'sandbox', egressPolicy: { rules: [] }, handlePrefix: 'synthetic' })
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.identifier, 'SYNTHETIC_TOKEN')));
    await upsertSecret(projectId, 'SYNTHETIC_TOKEN', 'updated🔑');
    const stored = await rows(projectId, 'SYNTHETIC_TOKEN');
    expect(stored).toHaveLength(2);
    const shared = stored.find((row) => row.ownerUserId === null);
    expect(shared).toMatchObject({ scope: 'connector', strategy: 'broker', consumer: 'connector', active: true, egressPolicy: null, handlePrefix: null });
    expect(shared && decryptChannelSecret(projectId, shared.valueEnc)).toBe('updated🔑');
    expect(stored.find((row) => row.ownerUserId === ownerUserId)?.valueEnc).toBe('personal-unchanged');
    expect(await readSecret(projectId, 'SYNTHETIC_TOKEN')).toBe('updated🔑');
    expect(await readSecret(otherProjectId, 'SYNTHETIC_TOKEN')).toBe('other-project');
    expect(await readSecret(projectId, 'MISSING_SYNTHETIC_TOKEN')).toBeNull();
  });

  test('concurrent first writes converge through the unique-conflict retry', async () => {
    const values = Array.from({ length: 8 }, (_, i) => `synthetic-race-${i}`);
    await Promise.all(values.map((value) => upsertSecret(projectId, 'SYNTHETIC_RACE', value)));
    const stored = await rows(projectId, 'SYNTHETIC_RACE');
    expect(stored).toHaveLength(1);
    expect(await readSecret(projectId, 'SYNTHETIC_RACE')).toBeOneOf(values);
  });

  test('delete uses both project and requested names; empty names delete nothing', async () => {
    await upsertSecret(projectId, 'SYNTHETIC_DELETE', 'delete');
    await upsertSecret(projectId, 'SYNTHETIC_KEEP', 'keep');
    await upsertSecret(otherProjectId, 'SYNTHETIC_DELETE', 'other');
    await deleteProjectSecrets(projectId, []);
    expect(await readSecret(projectId, 'SYNTHETIC_DELETE')).toBe('delete');
    await deleteProjectSecrets(projectId, ['SYNTHETIC_DELETE']);
    expect(await rows(projectId, 'SYNTHETIC_DELETE')).toHaveLength(0);
    expect(await readSecret(projectId, 'SYNTHETIC_KEEP')).toBe('keep');
    expect(await readSecret(otherProjectId, 'SYNTHETIC_DELETE')).toBe('other');
  });

  test('direct Slack caller round trips null and nonempty names; workspace lookup scopes platform and workspace', async () => {
    expect(await loadSlackInstall(projectId)).toBeNull();
    for (const teamName of [null, 'Synthetic workspace']) {
      await saveSlackInstall({ projectId, teamId: 'synthetic-workspace', teamName, botToken: 'synthetic-token', signingSecret: 'synthetic-signing', botUserId: 'synthetic-bot' });
      expect(await loadSlackInstall(projectId)).toMatchObject({ workspaceId: 'synthetic-workspace', workspaceName: teamName, botUserId: 'synthetic-bot' });
    }
    await db.insert(chatInstalls).values([
      { platform: 'teams', platformTeamId: 'synthetic-workspace', projectId: otherProjectId },
      { platform: 'slack', platformTeamId: 'synthetic-other-workspace', projectId: otherProjectId },
    ]);
    expect(await listProjectsForWorkspace('slack', 'synthetic-workspace')).toEqual([projectId]);
    expect(await listProjectsForWorkspace('teams', 'synthetic-workspace')).toEqual([otherProjectId]);
    expect(await listProjectsForWorkspace('slack', 'synthetic-missing')).toEqual([]);
  });
});
