import { describe, expect, mock, test } from 'bun:test';

let leader = true;
mock.module('./leader-election', () => ({ isLeader: () => leader }));
const { leaderTimer } = await import('./leader-timer');

describe('leaderTimer', () => {
  test('a stop then start while a tick runs leaves one chain, not two', async () => {
    leader = true;
    let ticks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      ticks += 1;
      if (ticks === 1) await gate;
      return 20;
    });
    timer.start();
    timer.stop();
    timer.start();
    release();
    await Bun.sleep(130);
    timer.stop();
    // One chain at ~20 ms spacing gives about 6 ticks. Two chains give about 12.
    expect(ticks).toBeLessThan(9);
  });

  test('a restart while a run is in flight starts the next run only after it ends', async () => {
    leader = true;
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (runs === 1) await gate;
      active -= 1;
      return 1_000;
    });
    timer.start();
    await Bun.sleep(20);
    expect(runs).toBe(1);
    timer.stop();
    timer.start();
    // The next run is due at once; it waits for the first run, however long that takes.
    await Bun.sleep(100);
    expect(runs).toBe(1);
    release();
    await Bun.sleep(50);
    timer.stop();
    // The second run returned 1 s: no third run in the 50 ms window.
    expect([runs, maxActive]).toEqual([2, 1]);
  });

  test('a tick runs nothing once the lease is gone', async () => {
    leader = false;
    let ticks = 0;
    const timer = leaderTimer(async () => {
      ticks += 1;
      return 10;
    });
    timer.start();
    await Bun.sleep(40);
    timer.stop();
    expect(ticks).toBe(0);
  });

  test('stop() resolves only after the in-flight tick settles', async () => {
    leader = true;
    let settled = false;
    let stopResolved = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      await gate;
      settled = true;
      return 60_000;
    });
    timer.start();
    await Bun.sleep(10);
    const stopped = Promise.resolve(timer.stop()).then(() => {
      stopResolved = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false); // the tick is still in flight
    expect(stopResolved).toBe(false); // stop() has not resolved yet
    release();
    await stopped;
    expect(settled).toBe(true);
    expect(stopResolved).toBe(true);
  });

  test('a tick that returns 0 re-arms immediately', async () => {
    leader = true;
    let ticks = 0;
    const timer = leaderTimer(async () => {
      ticks += 1;
      return 0;
    });
    timer.start();
    await Bun.sleep(25);
    expect(ticks).toBeGreaterThanOrEqual(3);
    timer.stop();
    const seen = ticks;
    await Bun.sleep(25);
    expect(ticks).toBe(seen);
  });

  test('stop ends the chain', async () => {
    leader = true;
    let ticks = 0;
    const timer = leaderTimer(async () => {
      ticks += 1;
      return 10;
    });
    timer.start();
    await Bun.sleep(35);
    timer.stop();
    const seen = ticks;
    await Bun.sleep(40);
    expect(ticks).toBe(seen);
  });

  test('a wake during an armed delay does not move the next tick earlier', async () => {
    leader = true;
    let ticks = 0;
    const timer = leaderTimer(async () => {
      ticks += 1;
      return 40;
    });
    timer.start();
    await Bun.sleep(5);
    expect(ticks).toBe(1);
    timer.wake();
    await Bun.sleep(20);
    expect(ticks).toBe(1); // still armed at 40 ms
    await Bun.sleep(45);
    expect(ticks).toBe(2); // the armed tick fired on its own delay
    timer.stop();
  });

  test('a wake while a run is in flight queues exactly one extra tick behind it', async () => {
    leader = true;
    let ticks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      ticks += 1;
      if (ticks === 1) await gate;
      return 60_000;
    });
    timer.start();
    await Bun.sleep(10);
    expect(ticks).toBe(1); // the first run is held by the gate
    timer.wake();
    timer.wake();
    release();
    await Bun.sleep(30);
    expect(ticks).toBe(2); // one extra tick, not one per wake
    timer.stop();
  });

  test('the waiting wake tick owns the next re-arm; run 2 returning 0 fires run 3', async () => {
    leader = true;
    const runs: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      runs.push(Date.now());
      if (runs.length === 1) await gate;
      // The held run returns a huge idle delay; the wake tick returns 0 (backlog).
      return runs.length === 2 ? 0 : 60_000;
    });
    timer.start();
    await Bun.sleep(10); // run 1 is held by the gate
    timer.wake();
    await Bun.sleep(5); // the 0 ms wake timer fires and takes over the next fire
    release(); // run 1 finishes while the wake tick is already waiting behind it
    await Bun.sleep(80);
    await timer.stop();
    // Run 1 finished with 60_000 and must not arm it over the waiting wake tick;
    // the wake tick re-runs, returns 0, and that 0 re-arms run 3 at once.
    // Losing the transfer stalls the backlog until the held run's 60_000.
    expect(runs.length).toBe(3);
    expect(runs[2] - runs[1]).toBeLessThan(40);
  });

  test('a wake whose extra tick already waits cannot queue a second one (no overlap)', async () => {
    leader = true;
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (runs === 1) await gate;
      else await Bun.sleep(20);
      active -= 1;
      return 2_000;
    });
    timer.start();
    await Bun.sleep(10); // run 1 is held by the gate
    timer.wake();
    await Bun.sleep(10); // the wake timer fired; its tick now waits behind run 1
    timer.wake(); // must not queue a second waiter against the same run
    await Bun.sleep(10);
    release();
    await Bun.sleep(60);
    await timer.stop();
    expect([runs, maxActive]).toEqual([2, 1]);
  });
});
