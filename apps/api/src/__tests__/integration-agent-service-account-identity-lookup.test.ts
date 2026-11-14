/**
 * Characterization: `ensureAgentServiceAccount` finds an agent's standing
 * identity whatever its status, while `activeAgentServiceAccountId` answers
 * only for an active one (and never creates).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  activeAgentServiceAccountId,
  disableServiceAccount,
  ensureAgentServiceAccount,
} from '../repositories/service-accounts';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const seeded: SeededProject[] = [];

afterAll(async () => {
  await removeSeeded(seeded);
});

describe('agent identity lookups', () => {
  test('active lookup is null for an inactive identity while ensure still returns it', async () => {
    const project = await seedProject('sa-identity-lookup');
    seeded.push(project);
    const args = { accountId: project.account_id, projectId: project.project_id, agentName: 'looker' };

    expect(await activeAgentServiceAccountId(args)).toBeNull();

    const id = await ensureAgentServiceAccount(args);
    expect(await activeAgentServiceAccountId(args)).toBe(id);

    await disableServiceAccount({
      accountId: project.account_id,
      serviceAccountId: id,
      disabledBy: crypto.randomUUID(),
    });

    expect(await activeAgentServiceAccountId(args)).toBeNull();
    expect(await ensureAgentServiceAccount(args)).toBe(id);
  });
});
