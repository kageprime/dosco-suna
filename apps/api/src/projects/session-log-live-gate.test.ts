import { describe, expect, test } from 'bun:test';
import { createLiveReadGate, LIVE_READ_LIMITS } from './session-log-live';

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('createLiveReadGate: the live box reads one replica runs at once', () => {
  test('callers of the same key share one read', async () => {
    const gate = createLiveReadGate<string>({ maxInFlight: 4, maxPerSession: 2, maxPerCaller: 4 });
    const box = deferred<string>();
    let runs = 0;
    const run = () => { runs++; return box.promise; };
    const reads = [gate.run('s1|root|40', 's1', 'u1', run), gate.run('s1|root|40', 's1', 'u1', run), gate.run('s1|root|40', 's1', 'u1', run)];
    box.resolve('page');
    expect(await Promise.all(reads)).toEqual(['page', 'page', 'page']);
    expect(runs).toBe(1);
  });

  test('past the per-session limit a read is refused (null) and nothing runs', async () => {
    const gate = createLiveReadGate<string>({ maxInFlight: 4, maxPerSession: 2, maxPerCaller: 4 });
    const box = deferred<string>();
    let runs = 0;
    const run = () => { runs++; return box.promise; };
    const a = gate.run('s1|root|40', 's1', 'u1', run);
    const b = gate.run('s1|root|10', 's1', 'u1', run);
    expect(await gate.run('s1|root|5', 's1', 'u1', run)).toBeNull();
    expect(runs).toBe(2);
    box.resolve('page');
    expect(await Promise.all([a, b])).toEqual(['page', 'page']);
  });

  test('past the replica limit a read is refused; a settled read frees its slot', async () => {
    const gate = createLiveReadGate<string>({ maxInFlight: 2, maxPerSession: 2, maxPerCaller: 4 });
    const box = deferred<string>();
    const a = gate.run('s1|root|40', 's1', 'u1', () => box.promise);
    const b = gate.run('s2|root|40', 's2', 'u1', () => box.promise);
    expect(await gate.run('s3|root|40', 's3', 'u1', async () => 'page')).toBeNull();
    box.resolve('page');
    await Promise.all([a, b]);
    expect(await gate.run('s3|root|40', 's3', 'u1', async () => 'page')).toBe('page');
  });

  test('one replica runs at most 8 box reads, 2 of one session, 3 for one caller', () => {
    expect(LIVE_READ_LIMITS).toEqual({ maxInFlight: 8, maxPerSession: 2, maxPerCaller: 3 });
  });

  test('past the per-caller limit a caller is refused while another caller still reads; joining a running read costs no slot', async () => {
    const gate = createLiveReadGate<string>({ maxInFlight: 8, maxPerSession: 2, maxPerCaller: 2 });
    const box = deferred<string>();
    const a = gate.run('s1|root|40', 's1', 'u1', () => box.promise);
    const b = gate.run('s2|root|40', 's2', 'u1', () => box.promise);
    expect(await gate.run('s3|root|40', 's3', 'u1', async () => 'page')).toBeNull();
    const joined = gate.run('s1|root|40', 's1', 'u1', async () => 'never runs');
    expect(await gate.run('s4|root|40', 's4', 'u2', async () => 'page')).toBe('page');
    box.resolve('page');
    expect(await Promise.all([a, b, joined])).toEqual(['page', 'page', 'page']);
  });

  test('a read that fails frees its slot too', async () => {
    const gate = createLiveReadGate<string>({ maxInFlight: 1, maxPerSession: 1, maxPerCaller: 1 });
    await expect(gate.run('s1|root|40', 's1', 'u1', async () => { throw new Error('box'); })).rejects.toThrow('box');
    expect(await gate.run('s1|root|40', 's1', 'u1', async () => 'page')).toBe('page');
  });
});
