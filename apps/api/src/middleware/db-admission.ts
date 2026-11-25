import { DEFAULT_DB_POOL_MAX } from '@kortix/db/connection-defaults';
import type { Context, Next } from 'hono';

import { config } from '../config';
import { logger } from '../lib/logger';
import { isExempt } from './request-deadline';

/**
 * Bounded admission in front of the shared Postgres pool.
 *
 * postgres.js has no acquire-queue timeout: when more callers want a connection
 * than the pool holds, the extra callers wait in an unbounded FIFO while every
 * individual statement stays fast. `statement_timeout` never fires and the
 * only bound is the 25 s request deadline, so a short burst becomes a wall of
 * 503/H12 answers that all land together (2026-11-24, 23:39-23:41 UTC).
 *
 * This gate does not replace the pool. It caps how many ordinary requests may
 * enter it at once and gives the rest a fast, retryable 503 instead of a place
 * in that FIFO. Two slots stay free for health probes and the queries a
 * request makes after it already holds a slot.
 */
export const DB_ADMISSION_RESERVE = 2;
export const DB_ADMISSION_WAIT_MS = 2_000;
export const DB_ADMISSION_CODE = 'db_pool_busy' as const;

interface Waiter {
  grant: () => void;
  cancel: () => void;
}

export interface DbAdmissionOptions {
  max: number;
  waitMs: number;
  onWait?: (waitMs: number, held: number) => void;
  onReject?: (waitedMs: number, held: number) => void;
}

/**
 * A counting semaphore with a bounded wait. A rejected caller never enters the
 * pool, so it cannot add to the queue that caused the rejection.
 */
export function createDbAdmission({ max, waitMs, onWait, onReject }: DbAdmissionOptions) {
  const ceiling = Math.max(1, Math.floor(max));
  const waiters: Waiter[] = [];
  let held = 0;

  return {
    get held() {
      return held;
    },
    get ceiling() {
      return ceiling;
    },
    async acquire(): Promise<number> {
      if (held < ceiling) {
        held += 1;
        return 0;
      }
      const started = Date.now();
      await new Promise<void>((resolve, reject) => {
        let waiter: Waiter;
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          const waited = Date.now() - started;
          onReject?.(waited, held);
          reject(new Error(`${DB_ADMISSION_CODE} waited ${waited}ms`));
        }, waitMs);
        waiter = {
          grant: () => {
            clearTimeout(timer);
            held += 1;
            resolve();
          },
          cancel: () => clearTimeout(timer),
        };
        waiters.push(waiter);
      });
      const waited = Date.now() - started;
      onWait?.(waited, held);
      return waited;
    },
    release(): void {
      // Free the slot first. A waiter then takes that same slot through
      // `grant()`, so `held` returns to the ceiling but never exceeds it.
      held -= 1;
      const next = waiters.shift();
      if (next) {
        next.cancel();
        next.grant();
      }
    },
  };
}

const POOL_MAX = config.DB_POOL_MAX || DEFAULT_DB_POOL_MAX;
const admission = createDbAdmission({
  max: POOL_MAX - DB_ADMISSION_RESERVE,
  waitMs: config.DB_ADMISSION_WAIT_MS || DB_ADMISSION_WAIT_MS,
  onWait: (waited) => {
    if (waited >= 500) {
      logger.warn('DB admission queued a request', { db_admission_wait_ms: waited, held: admission.held });
    }
  },
  onReject: (waited) => {
    logger.warn('DB admission rejected a request', {
      db_admission_wait_ms: waited,
      db_admission_status: 'rejected',
      held: admission.held,
    });
  },
});

function isProbe(c: Context): boolean {
  const path = c.req.path;
  return (
    path === '/health' ||
    path === '/v1/health' ||
    path.endsWith('/health/live') ||
    path.endsWith('/health/ready')
  );
}

/** Mount before routes. Streaming, long-poll and health traffic never takes a slot. */
export async function dbAdmission(c: Context, next: Next): Promise<void | Response> {
  if (isProbe(c) || isExempt(c)) {
    await next();
    return;
  }
  try {
    await admission.acquire();
  } catch {
    c.header('Retry-After', '1');
    return c.json({ error: 'Service busy', code: DB_ADMISSION_CODE }, 503);
  }
  try {
    await next();
  } finally {
    admission.release();
  }
}
