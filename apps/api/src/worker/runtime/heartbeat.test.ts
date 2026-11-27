import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({ config: { INTERNAL_KORTIX_ENV: 'prod' } }));
mock.module('../../lib/logger', () => ({ logger: { warn() {}, info() {}, error() {}, localWarn() {} } }));
const { observeWorkerTicks, runWorkerTick } = await import('../../shared/audit-scope');
const { staleTicks, startJobHeartbeat, onJobReport } = await import('./heartbeat');

const MIN = 60_000;

afterEach(() => {
  observeWorkerTicks(null);
  onJobReport(null);
});

describe('staleTicks', () => {
  test('a job is stale only after its own limit since its last success', () => {
    const ticks = new Map([['hourly', { firstStartAt: 0, lastOkAt: 5 * MIN }]]);
    expect(staleTicks(ticks, { hourly: 180 * MIN }, 185 * MIN)).toEqual([]);
    expect(staleTicks(ticks, { hourly: 180 * MIN }, 185 * MIN + 1)).toEqual(['hourly']);
  });

  test('a backlog run every 5 s that then idles for an hour is not stale (the old adaptive limit paged here)', () => {
    const ticks = new Map([['purge', { firstStartAt: 0, lastOkAt: 15_000 }]]);
    expect(staleTicks(ticks, { purge: 180 * MIN }, 15_000 + 59 * MIN)).toEqual([]);
  });

  test('a job whose ticks keep failing is stale once its first start is past the limit', () => {
    const ticks = new Map([['failing', { firstStartAt: 0, lastOkAt: null }]]);
    expect(staleTicks(ticks, { failing: 10 * MIN }, 10 * MIN + 1)).toEqual(['failing']);
  });

  test('a one-shot (null limit) is never judged', () => {
    const ticks = new Map([['once', { firstStartAt: 0, lastOkAt: null }]]);
    expect(staleTicks(ticks, { once: null }, 1000 * MIN)).toEqual([]);
  });
});

describe('startJobHeartbeat', () => {
  test('watches the registered jobs through runWorkerTick and writes one metric line', async () => {
    let now = 0;
    const lines: string[] = [];
    const heartbeat = startJobHeartbeat(
      [
        { ticks: { 'job-a': 10 * MIN }, start() {}, stop() {} },
        { ticks: { 'job-b': 10 * MIN }, start() {}, stop() {}, stalled: () => true },
      ],
      { now: () => now, write: (line) => lines.push(line), intervalMs: 3_600_000 },
    );
    await runWorkerTick('job-a', async () => undefined);
    await runWorkerTick('not-a-job', async () => undefined);
    now = 10 * MIN + 1;
    const stale = heartbeat.report();
    heartbeat.stop();

    expect(stale).toEqual(['job-a', 'job-b']);
    expect(JSON.parse(lines[0]!)).toEqual({
      kortix_metric: 'worker_jobs',
      environment: 'prod',
      stale_jobs: 2,
      jobs_seen: 1,
      stale: ['job-a', 'job-b'],
    });
  });

  test('a tick that throws does not count as a success, and stop() removes the observer', async () => {
    let now = 0;
    const heartbeat = startJobHeartbeat([{ ticks: { 'job-a': 10 * MIN }, start() {}, stop() {} }], {
      now: () => now,
      write: () => {},
      intervalMs: 3_600_000,
    });
    await runWorkerTick('job-a', async () => undefined);
    now = MIN;
    await runWorkerTick('job-a', async () => {
      throw new Error('boom');
    }).catch(() => {});
    now = 10 * MIN + 1;
    expect(heartbeat.report()).toEqual(['job-a']);
    heartbeat.stop();
    await runWorkerTick('job-a', async () => undefined);
    expect(heartbeat.report()).toEqual(['job-a']);
  });

  test('the status-page heartbeat gets a ping only from a report with no stale job', async () => {
    let now = 0;
    const pings: string[] = [];
    const heartbeat = startJobHeartbeat([{ ticks: { 'job-a': 10 * MIN }, start() {}, stop() {} }], {
      now: () => now,
      write: () => {},
      intervalMs: 3_600_000,
      heartbeatUrl: 'https://uptime.example.test/api/v1/heartbeat/abc',
      ping: (url) => pings.push(url),
    });
    await runWorkerTick('job-a', async () => undefined);
    now = MIN;
    expect(heartbeat.report()).toEqual([]);
    expect(pings).toEqual(['https://uptime.example.test/api/v1/heartbeat/abc']);

    now = 11 * MIN + 1;
    expect(heartbeat.report()).toEqual(['job-a']);
    expect(pings).toHaveLength(1);
    heartbeat.stop();
  });

  test('no heartbeat URL (dev, staging, self-host) sends no ping', () => {
    const pings: string[] = [];
    const heartbeat = startJobHeartbeat([], { write: () => {}, intervalMs: 3_600_000, ping: (url) => pings.push(url) });
    expect(heartbeat.report()).toEqual([]);
    heartbeat.stop();
    expect(pings).toEqual([]);
  });
});

describe('onJobReport', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const jobs = () => names.map((name) => ({ ticks: { [name]: 10 * MIN }, start() {}, stop() {} }));

  test('counts a wedge only while at least WEDGED_STALE_JOBS ticks stay stale', async () => {
    let now = 0;
    const seen: { stale: readonly string[]; wedgedForMs: number }[] = [];
    onJobReport((health) => seen.push(health));
    const heartbeat = startJobHeartbeat(jobs(), { now: () => now, write: () => {}, intervalMs: 3_600_000 });
    for (const name of names) await runWorkerTick(name, async () => undefined);
    now = MIN;
    expect(heartbeat.report()).toEqual([]);
    expect(seen.at(-1)).toEqual({ stale: [], wedgedForMs: 0 });

    now = 11 * MIN;
    expect(heartbeat.report()).toEqual(names);
    expect(seen.at(-1)).toEqual({ stale: names, wedgedForMs: 0 });

    now = 26 * MIN;
    expect(heartbeat.report()).toEqual(names);
    expect(seen.at(-1)).toEqual({ stale: names, wedgedForMs: 15 * MIN });

    for (const name of names) await runWorkerTick(name, async () => undefined);
    now = 27 * MIN;
    expect(heartbeat.report()).toEqual([]);
    expect(seen.at(-1)).toEqual({ stale: [], wedgedForMs: 0 });
    heartbeat.stop();
  });

  test('a single slow sweep is never a wedge, however long it runs', async () => {
    let now = 0;
    const seen: { stale: readonly string[]; wedgedForMs: number }[] = [];
    onJobReport((health) => seen.push(health));
    const heartbeat = startJobHeartbeat(jobs(), { now: () => now, write: () => {}, intervalMs: 3_600_000 });
    for (const name of names) await runWorkerTick(name, async () => undefined);
    now = MIN;
    for (const name of names.slice(1)) await runWorkerTick(name, async () => undefined);
    now = 10 * MIN + 1;
    expect(heartbeat.report()).toEqual(['a']);
    expect(seen.at(-1)).toEqual({ stale: ['a'], wedgedForMs: 0 });

    now = 600 * MIN;
    for (const name of names.slice(1)) await runWorkerTick(name, async () => undefined);
    expect(heartbeat.report()).toEqual(['a']);
    expect(seen.at(-1)?.wedgedForMs).toBe(0);
    expect(seen.at(-1)?.stale).toHaveLength(1);
    heartbeat.stop();
  });

  test('a stopped heartbeat calls no listener again', async () => {
    let now = 0;
    let reports = 0;
    onJobReport(() => reports += 1);
    const heartbeat = startJobHeartbeat(jobs(), { now: () => now, write: () => {}, intervalMs: 3_600_000 });
    heartbeat.report();
    expect(reports).toBe(1);
    heartbeat.stop();
    expect(reports).toBe(1);
  });
});
