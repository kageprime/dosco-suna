import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { COST_READ_CODE, COST_READ_MAX_WAITING, withCostReadGuard } from './cost-read-guard';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HTTPException);
  return (error as HTTPException).getResponse();
}

function saturate(gate: Promise<void>) {
  // one running read plus a full queue
  return Array.from({ length: 1 + COST_READ_MAX_WAITING }, () => withCostReadGuard(() => gate));
}

describe('withCostReadGuard', () => {
  test('refuses a read past the full queue with 429, a Retry-After and a stable code', async () => {
    const gate = deferred();
    const held = saturate(gate.promise);
    const res = await refusal(withCostReadGuard(async () => 'never'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect((await res.json()).code).toBe(COST_READ_CODE);
    gate.resolve();
    await Promise.all(held);
  });

  test('never runs more than one read at once, whatever the burst', async () => {
    let active = 0;
    let peak = 0;
    let ran = 0;
    const step = async () => {
      active += 1;
      ran += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
    };
    const burst = Array.from({ length: 20 }, () => withCostReadGuard(step).catch(() => undefined));
    await Promise.all(burst);
    expect(peak).toBe(1);
    expect(ran).toBe(1 + COST_READ_MAX_WAITING);
  });

  test('queued reads run in order once the running one settles', async () => {
    const gate = deferred();
    const order: number[] = [];
    const reads = [0, 1, 2].map((i) =>
      withCostReadGuard(async () => {
        if (i === 0) await gate.promise;
        order.push(i);
      }),
    );
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all(reads);
    expect(order).toEqual([0, 1, 2]);
  });

  test('frees the permit when a read fails', async () => {
    await expect(withCostReadGuard(async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await withCostReadGuard(async () => 'ok')).toBe('ok');
  });

  test('a failing read hands the permit to the queued read', async () => {
    const gate = deferred();
    const failing = withCostReadGuard(async () => { await gate.promise; throw new Error('db down'); });
    const queued = withCostReadGuard(async () => 'ok');
    gate.resolve();
    await expect(failing).rejects.toThrow('db down');
    expect(await queued).toBe('ok');
  });

  test('keeps the permit until the read settles, then frees it', async () => {
    const gate = deferred();
    const held = saturate(gate.promise);
    expect((await refusal(withCostReadGuard(async () => 'x'))).status).toBe(429);
    gate.resolve();
    await Promise.all(held);
    expect(await withCostReadGuard(async () => 'x')).toBe('x');
  });
});
