/**
 * insertChangeRequest — the open-CR insert with per-project number allocation.
 *
 * The pg failure detail hangs off the DrizzleQueryError `cause`. A matcher on
 * the outer message ("Failed query: …") never saw "duplicate key", so a
 * racing open paged as an unhandled 500 (prod 2026-11-07, pattern 4df56723;
 * constraint `idx_change_requests_project_number`). These tests pin the
 * behavior: a wrapped 23505 retries the allocation, any other error rethrows
 * on the first attempt, and the attempts budget can exhaust.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';

/** The shape a 23505 arrives in through drizzle: a DrizzleQueryError whose
 *  message is only "Failed query: …" and the pg detail hangs off `cause`. */
function wrappedUniqueViolation(constraint: string): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "kortix"."change_requests" ("cr_id", "account_id", "project_id", "number", …)',
    ['…'],
    Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
      name: 'PostgresError',
      code: '23505',
    }),
  );
}

interface AllocationRow {
  max: number;
}

const state = {
  allocations: [] as AllocationRow[],
  insertedValues: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<'duplicate' | 'other' | 'ok'>,
};

function wrappedDuplicate(): Error {
  return wrappedUniqueViolation('idx_change_requests_project_number');
}

let rowCounter = 0;
function okRow(values: Record<string, unknown>): Record<string, unknown> {
  rowCounter += 1;
  return { cr_id: `cr-${rowCounter}`, number: values.number, title: values.title };
}

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          const next = state.allocations.shift();
          if (!next) throw new Error('allocation not scripted');
          return [{ max: next.max }];
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          state.insertedValues.push(values);
          const kind = state.inserts.shift();
          if (!kind) throw new Error('insert not scripted');
          if (kind === 'duplicate') throw wrappedDuplicate();
          if (kind === 'other') throw new Error('connection refused');
          return [okRow(values)];
        },
      }),
    }),
  },
}));

const { insertChangeRequest } = await import('./change-requests');

beforeEach(() => {
  state.allocations = [];
  state.insertedValues = [];
  state.inserts = [];
  rowCounter = 0;
});

describe('insertChangeRequest', () => {
  const values = {
    accountId: 'account-1',
    projectId: 'project-1',
    title: 'a change request',
    baseRef: 'main',
    headRef: 'session-branch',
    createdBy: 'user-1',
  };

  test('a wrapped 23505 retry re-allocates the number and inserts', async () => {
    // Winner's open landed first: pre-race max 22, then the winner's 23.
    state.allocations = [{ max: 22 }, { max: 23 }];
    state.inserts = ['duplicate', 'ok'];

    const row = await insertChangeRequest(values);

    expect(row?.number).toBe(24);
    expect(state.insertedValues.map((v) => v.number)).toEqual([23, 24]);
    for (const v of state.insertedValues) expect(v.projectId).toBe('project-1');
  });

  test('a non-duplicate insert failure rethrows on the first attempt', async () => {
    state.allocations = [{ max: 5 }];
    state.inserts = ['other'];

    await expect(insertChangeRequest(values)).rejects.toThrow('connection refused');
    expect(state.insertedValues).toHaveLength(1);
  });

  test('exhausting the attempts budget returns null instead of throwing', async () => {
    state.allocations = [{ max: 0 }, { max: 0 }, { max: 0 }];
    state.inserts = ['duplicate', 'duplicate', 'duplicate'];

    const row = await insertChangeRequest(values);
    expect(row).toBeNull();
    expect(state.insertedValues).toHaveLength(3);
  });
});
