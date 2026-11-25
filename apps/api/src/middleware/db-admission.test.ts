import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { createDbAdmission, DB_ADMISSION_CODE, dbAdmission } from './db-admission';

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('createDbAdmission', () => {
  test('grants up to the ceiling and hands a released slot to the first waiter', async () => {
    const gate = createDbAdmission({ max: 2, waitMs: 1_000 });
    expect(await gate.acquire()).toBe(0);
    expect(await gate.acquire()).toBe(0);
    expect(gate.held).toBe(2);

    let granted = false;
    const queued = gate.acquire().then((waited) => {
      granted = true;
      return waited;
    });
    await tick(10);
    expect(granted).toBe(false);

    gate.release();
    expect(await queued).toBeGreaterThanOrEqual(0);
    expect(gate.held).toBe(2);

    gate.release();
    gate.release();
    expect(gate.held).toBe(0);
  });

  test('rejects a waiter after the bounded wait without entering the pool', async () => {
    let rejected: { waited: number; held: number } | null = null;
    const gate = createDbAdmission({
      max: 1,
      waitMs: 40,
      onReject: (waited, held) => {
        rejected = { waited, held };
      },
    });
    expect(await gate.acquire()).toBe(0);
    await expect(gate.acquire()).rejects.toThrow(DB_ADMISSION_CODE);
    expect(gate.held).toBe(1);
    expect(rejected).not.toBeNull();
    expect((rejected as unknown as { waited: number }).waited).toBeGreaterThanOrEqual(40);
  });

  test('never opens more slots than the ceiling after a timeout', async () => {
    const gate = createDbAdmission({ max: 1, waitMs: 20 });
    await gate.acquire();
    await gate.acquire().catch(() => undefined);
    await tick(30);
    gate.release();
    expect(gate.held).toBe(0);
    expect(await gate.acquire()).toBe(0);
    expect(gate.held).toBe(1);
  });
});

describe('dbAdmission middleware', () => {
  test('lets a health probe through without a slot', async () => {
    const app = new Hono();
    app.use('*', dbAdmission);
    app.get('/v1/health', (c) => c.json({ ok: true }));
    const response = await app.request('/v1/health');
    expect(response.status).toBe(200);
  });

  test('serves an ordinary bounded route', async () => {
    const app = new Hono();
    app.use('*', dbAdmission);
    app.get('/v1/accounts', (c) => c.json({ ok: true }));
    const response = await app.request('/v1/accounts');
    expect(response.status).toBe(200);
  });
});
