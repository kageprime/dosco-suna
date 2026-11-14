/**
 * Integration test (real local PostgreSQL): the stuck-provisioning reaper stops
 * restarting a box whose accepted in-place recoveries never boot.
 *
 * 2026-11-08..11: Platinum answered `removed` for four `failed-start` boxes,
 * `recoverInPlace` answered `recovering` and called `/start`, the boot failed,
 * and the next pass did it again, about 20 times an hour for 3 days. The rows
 * stayed `provisioning` for the whole time.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realComputeMetering from '../billing/services/compute-metering';
import * as realProviders from '../platform/providers';
import * as realSandboxRuntimeRefresh from '../projects/lib/sandbox-runtime-refresh';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

let providerStatus = 'removed';
let recoveries = 0;
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    getStatus: async () => providerStatus,
    // Platinum's answer for a `failed-start` box that booted before.
    recoverInPlace: async () => {
      recoveries += 1;
      return 'recovering';
    },
  }),
}));
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  reopenComputeForSandbox: async () => undefined,
  markComputeSessionAlive: async () => undefined,
}));
mock.module('../projects/lib/sandbox-runtime-refresh', () => ({
  ...realSandboxRuntimeRefresh,
  scheduleSandboxRuntimeRefresh: () => undefined,
}));

const { convergeStuckProvisioningRuntimes } = await import('../projects/reaping/stuck-provisioning');
const { MAX_IN_PLACE_RECOVERY_ATTEMPTS } = await import('../projects/runtime-identity');

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];
/** One pass after the 10-minute recovery lease of the pass before it lapsed. */
const PASS_MS = 11 * 60_000;

let project: SeededProject;
const created: string[] = [];

/** A row the incident left behind: `provisioning`, recovering, its lease lapsed. */
async function stuckRecoveringRow(t0: Date): Promise<string> {
  const sessionId = crypto.randomUUID();
  const before = new Date(t0.getTime() - PASS_MS).toISOString();
  await db.execute(sql`
    insert into kortix.project_sessions
      (session_id, account_id, project_id, branch_name, agent_name, status, metadata, updated_at)
    values
      (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, ${sessionId},
       'default', 'provisioning', '{}'::jsonb, ${before}::timestamptz)`);
  await db.execute(sql`
    insert into kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, provider, status, metadata,
       updated_at)
    values
      (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
       ${`sbx_recovery_cap_${sessionId.slice(0, 8)}`}, 'platinum', 'provisioning',
       ${JSON.stringify({
         runtimeIdentityState: 'recovering',
         runtimeRecoveryLeaseId: 'lease-from-an-earlier-pass',
         runtimeRecoveryLeaseExpiresAtMs: t0.getTime() - 1,
       })}::jsonb,
       ${before}::timestamptz)`);
  created.push(sessionId);
  return sessionId;
}

async function read(sessionId: string): Promise<{ session: Row; sandbox: Row & { metadata: Row } }> {
  const [session] = rows(
    await db.execute(sql`select status from kortix.project_sessions where session_id = ${sessionId}`),
  );
  const [sandbox] = rows(
    await db.execute(
      sql`select status, metadata from kortix.session_sandboxes where sandbox_id = ${sessionId}::uuid`,
    ),
  );
  return { session: session!, sandbox: sandbox as Row & { metadata: Row } };
}

beforeAll(async () => {
  project = await seedProject('in-place-recovery-cap-test');
});

afterAll(async () => {
  for (const sessionId of created) {
    // `guard_session_sandbox_identity` refuses to delete the sandbox row of a
    // session that is not tombstoned.
    await db.execute(sql`
      update kortix.project_sessions
         set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
       where session_id = ${sessionId}`);
    await db.execute(sql`delete from kortix.session_sandboxes where sandbox_id = ${sessionId}::uuid`);
    await db.execute(sql`delete from kortix.project_sessions where session_id = ${sessionId}`);
  }
  await removeSeeded([project]);
});

describe('in-place recovery attempt cap', () => {
  test('three accepted recoveries that never boot end in a preserved loss, with no fourth start', async () => {
    providerStatus = 'removed';
    recoveries = 0;
    const t0 = new Date();
    const sessionId = await stuckRecoveringRow(t0);

    for (let pass = 0; pass < MAX_IN_PLACE_RECOVERY_ATTEMPTS; pass += 1) {
      const result = await convergeStuckProvisioningRuntimes(new Date(t0.getTime() + pass * PASS_MS));
      expect(result.lost).toBe(0);
      const { session, sandbox } = await read(sessionId);
      expect(session.status).toBe('provisioning');
      expect(sandbox.status).toBe('provisioning');
      expect(sandbox.metadata.runtimeIdentityState).toBe('recovering');
      expect(sandbox.metadata.runtimeRecoveryAttempts).toBe(pass + 1);
    }
    expect(recoveries).toBe(MAX_IN_PLACE_RECOVERY_ATTEMPTS);

    const final = await convergeStuckProvisioningRuntimes(
      new Date(t0.getTime() + MAX_IN_PLACE_RECOVERY_ATTEMPTS * PASS_MS),
    );
    expect(final.lost).toBe(1);
    expect(recoveries).toBe(MAX_IN_PLACE_RECOVERY_ATTEMPTS);
    const { session, sandbox } = await read(sessionId);
    expect(session.status).toBe('stopped');
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.metadata).toMatchObject({
      runtimeIdentityState: 'unavailable',
      runtimeUnavailableReason: 'provisioning_runtime_removed',
      stopReason: 'provider_removed',
    });
    expect(sandbox.metadata).not.toHaveProperty('runtimeRecoveryLeaseId');
    expect(sandbox.metadata).not.toHaveProperty('runtimeRecoveryAttempts');

    // A later pass leaves the preserved loss alone: the reaper selects
    // `provisioning` rows only.
    await convergeStuckProvisioningRuntimes(
      new Date(t0.getTime() + (MAX_IN_PLACE_RECOVERY_ATTEMPTS + 1) * PASS_MS),
    );
    expect(recoveries).toBe(MAX_IN_PLACE_RECOVERY_ATTEMPTS);
  });

  test('a box that boots clears the count, so a later failure gets the full budget', async () => {
    providerStatus = 'removed';
    recoveries = 0;
    const t0 = new Date();
    const sessionId = await stuckRecoveringRow(t0);

    await convergeStuckProvisioningRuntimes(t0);
    await convergeStuckProvisioningRuntimes(new Date(t0.getTime() + PASS_MS));
    expect((await read(sessionId)).sandbox.metadata.runtimeRecoveryAttempts).toBe(2);

    providerStatus = 'running';
    const booted = await convergeStuckProvisioningRuntimes(new Date(t0.getTime() + 2 * PASS_MS));
    expect(booted.activated).toBe(1);
    const { session, sandbox } = await read(sessionId);
    expect(session.status).toBe('running');
    expect(sandbox.status).toBe('active');
    expect(sandbox.metadata.runtimeIdentityState).toBe('recovered');
    expect(sandbox.metadata).not.toHaveProperty('runtimeRecoveryAttempts');
  });
});
