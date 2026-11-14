/**
 * Job heartbeat: is every scheduled job still ticking?
 *
 * 2026-10-16, prod: a leader flap left 18 job loops stopped for 12.5 h and no
 * alert fired. The runtime now watches every tick of the registered jobs
 * (`observeWorkerTicks`). A job is stale when its last successful tick is older
 * than the limit its registry entry declares (`Job.ticks`). A job is judged
 * only after its first tick in this leader term: a job that config switches
 * off never ticks and never reports stale. A tick that hangs, a timer that
 * died and a tick that throws every time all leave the last success behind.
 *
 * Once a minute the lease holder writes one JSON line to stdout. A CloudWatch
 * log metric filter (`infra/terraform/modules/ecs-api`) turns it into the
 * `Dosco/Worker` `StaleJobs` metric, and an alarm pages when it stays at 1
 * or more for 5 minutes.
 *
 * The same report feeds the "Kortix Cloud Worker" row on status.kortix.com:
 * when no job is stale, it sends one GET to the Better Stack heartbeat
 * `BETTERSTACK_WORKER_HEARTBEAT_URL` (prod only). Better Stack opens an
 * incident when no ping arrives for period + grace (60 s + 300 s). A report
 * with a stale job sends nothing, so does a process that holds no lease or
 * hangs: the CloudWatch alarms see neither of those two.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { observeWorkerTicks } from '../../shared/audit-scope';
import type { Job } from './job';

const REPORT_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 10_000;

export interface TickTimes {
  firstStartAt: number;
  /** When a tick last finished without throwing. */
  lastOkAt: number | null;
}

/** The tick names whose last successful tick is older than their limit. */
export function staleTicks(
  ticks: ReadonlyMap<string, TickTimes>,
  limits: Readonly<Record<string, number | null>>,
  now: number,
): string[] {
  const stale: string[] = [];
  for (const [name, times] of ticks) {
    const limit = limits[name];
    if (limit == null) continue;
    if (now - (times.lastOkAt ?? times.firstStartAt) > limit) stale.push(name);
  }
  return stale.sort();
}

/** One GET to the status-page heartbeat. A failure is logged to stdout only, never shipped. */
function pingStatusPage(url: string): void {
  fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
    .then((res) => {
      void res.body?.cancel();
      if (!res.ok) logger.localWarn('[worker] status heartbeat refused', { status: res.status });
    })
    .catch((error: unknown) => {
      logger.localWarn('[worker] status heartbeat failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Watch the ticks of `jobs` and report once a minute. Returns the stop. */
export function startJobHeartbeat(
  jobs: readonly Job[],
  options: {
    now?: () => number;
    write?: (line: string) => void;
    intervalMs?: number;
    heartbeatUrl?: string;
    ping?: (url: string) => void;
  } = {},
): { stop(): void; report(): string[] } {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const heartbeatUrl = options.heartbeatUrl ?? config.BETTERSTACK_WORKER_HEARTBEAT_URL;
  const ping = options.ping ?? pingStatusPage;
  const limits: Record<string, number | null> = Object.assign({}, ...jobs.map((job) => job.ticks));
  const ticks = new Map<string, TickTimes>();

  observeWorkerTicks((name) => {
    if (!(name in limits)) return undefined;
    if (!ticks.has(name)) {
      ticks.set(name, { firstStartAt: now(), lastOkAt: null });
      logger.info('[worker] job ticking', { job: name });
    }
    return (error) => {
      if (error !== undefined) return;
      const times = ticks.get(name);
      if (times) times.lastOkAt = now();
    };
  });

  const report = (): string[] => {
    const stale = staleTicks(ticks, limits, now());
    for (const job of jobs) {
      if (job.stalled?.()) stale.push(...Object.keys(job.ticks).filter((name) => !stale.includes(name)));
    }
    write(
      JSON.stringify({
        kortix_metric: 'worker_jobs',
        environment: config.INTERNAL_KORTIX_ENV,
        stale_jobs: stale.length,
        jobs_seen: ticks.size,
        stale,
      }),
    );
    if (stale.length > 0) logger.warn('[worker] scheduled jobs are stale', { stale });
    else if (heartbeatUrl) ping(heartbeatUrl);
    return stale;
  };

  const timer = setInterval(report, options.intervalMs ?? REPORT_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      observeWorkerTicks(null);
    },
    report,
  };
}
