import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DEFAULT_DB_POOL_MAX } from './connection-defaults';
import * as schema from './schema';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Pool + timeout defaults for the postgres.js client.
 *
 * Why these exist (prod incident, 2026-06-08): the client used to be created
 * with *no* limits — postgres.js then defaults to `max: 10` per process and
 * **no statement/connect/idle timeouts**. With 2 prod replicas that is only ~20
 * DB connections for the entire fleet, and postgres.js has **no acquire/queue
 * timeout**: once every connection is busy, further queries queue *forever*
 * until the caller gives up. A single stuck query therefore pinned a connection
 * indefinitely and cascaded into fleet-wide "Request timed out after 30s" on
 * completely unrelated endpoints (sandbox-health, secrets, change-requests,
 * iam/effective, …) — because they were all just waiting for a free connection.
 *
 * The fix has two parts:
 *   1. `statement_timeout` — the key anti-cascade lever. Caps how long any
 *      single statement (and thus a checked-out connection) can run, so a stuck
 *      query frees its slot and the queue drains instead of hanging the fleet.
 *      (Investigation found real offenders: an unindexed 21M-row audit scan at
 *      80–120s, and account-deletion sweeps at 36–64s, each pinning a connection
 *      for up to the 2-min server statement_timeout.)
 *   2. An env-tunable `max` so normal concurrent page loads can run without
 *      letting a rolling deployment exhaust the PostgreSQL server.
 *
 * WHERE THE TIMEOUT LIVES (pooler incident, 2026-09-18): this used to be sent
 * as a connection startup parameter (`connection: { statement_timeout }`).
 * Supavisor in transaction-pooling mode rejects unknown startup parameters
 * with `08P01 unsupported startup parameter`, failing EVERY query — so the
 * timeout is now enforced as a ROLE-LEVEL default instead:
 *   ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '25s';
 * (applied to Supabase Cloud at the 2026-09-18 migration; fresh self-host
 * installs get it from 0000_bootstrap.sql). Role defaults apply at backend
 * startup, so they survive pooling, and per-migration `SET statement_timeout`
 * overrides (see the checksum-guarded runtime overrides) still win wherever
 * a job legitimately needs longer.
 *
 * SIZING: prod may connect directly (db.<ref>.supabase.co:5432) or through the
 * pooler (db.<ref>.supabase.co:6543) — both are supported; `prepare: false`
 * below is what makes the pooler safe. Every client connection consumes one
 * real backend on direct. PostgreSQL exposes 237 non-reserved slots. ECS can
 * overlap 10 old tasks and 10 new tasks during a rolling deployment. The API
 * also owns an audit pool, a leader-election connection, and a transient
 * startup schema probe. The capacity invariant in
 * apps/api/src/shared/database-capacity.test.ts accounts for all four sources
 * and preserves a non-API reserve. If replica count or pool size grows, update
 * that invariant before changing this default.
 *
 * All knobs are env-overridable so prod can tune without a code change. The
 * app's background workers (maintenance sweeps, migration workers) only ever run
 * small batched/indexed statements, so the 25s cap is safe for them; if a future
 * job needs a longer single statement it should `SET LOCAL statement_timeout`
 * inside its own transaction rather than raising the request-path default.
 */
const POOL_MAX = intFromEnv('DB_POOL_MAX', DEFAULT_DB_POOL_MAX);
const IDLE_TIMEOUT_S = intFromEnv('DB_IDLE_TIMEOUT_S', 30);
const CONNECT_TIMEOUT_S = intFromEnv('DB_CONNECT_TIMEOUT_S', 10);
const MAX_LIFETIME_S = intFromEnv('DB_MAX_LIFETIME_S', 60 * 30); // 30 min

/**
 * Observability hooks for {@link createDb}.
 *
 * `onQuery` runs when a statement is dispatched (including the wait for a pool
 * connection) and returns the function called when it settles. A transaction
 * is reported as one operation spanning BEGIN..COMMIT, plus one per statement
 * inside it. Hooks must never throw; they run on every query.
 */
export interface DbHooks {
  onQuery?: () => () => void;
}

type AnySql = postgres.Sql<{}>;

const QUERY_SETTLE_METHODS = ['then', 'catch', 'finally'] as const;

/**
 * Report a lazily-executed postgres.js query to `onQuery`. A postgres.js
 * `Query` only starts on its first `then`/`catch`/`finally`, so the clock
 * starts there. The settle observer uses the base `Promise.prototype.then`,
 * which neither starts the query a second time nor leaves a rejection unhandled.
 */
function observeQuery<Q extends object>(query: Q, onQuery: () => () => void): Q {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const end = onQuery();
    Promise.prototype.then.call(query, end, end);
  };
  const target = query as Record<string, unknown>;
  for (const method of QUERY_SETTLE_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      start();
      return (original as (...a: unknown[]) => unknown).apply(query, args);
    };
  }
  return query;
}

/**
 * Wrap the three postgres.js entry points Drizzle uses — `unsafe` (every
 * statement), `begin` (transactions) and `savepoint` (nested transactions) —
 * so `onQuery` sees every round trip. Everything else passes through.
 */
export function instrumentSql<S extends object>(sql: S, onQuery: () => () => void): S {
  return new Proxy(sql, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'unsafe') {
        return (...args: unknown[]) => observeQuery((value as (...a: unknown[]) => object).apply(target, args), onQuery);
      }
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => {
          const last = args.length - 1;
          const callback = args[last];
          if (typeof callback === 'function') {
            args[last] = (inner: object) => callback(instrumentSql(inner, onQuery));
          }
          const end = onQuery();
          const pending = (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          pending.then(end, end);
          return pending;
        };
      }
      return value;
    },
  });
}

/**
 * Create a Drizzle database client.
 *
 * @param databaseUrl - PostgreSQL connection string
 * @param options - Additional postgres.js options (override the defaults below)
 * @param hooks - Optional observability hooks (see {@link DbHooks})
 * @returns Drizzle database client with full schema
 */
export function createDb(databaseUrl: string, options?: postgres.Options<{}>, hooks?: DbHooks) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = postgres(databaseUrl, {
    // prepare: false keeps us compatible with the Supabase transaction pooler
    // (Supavisor multiplexes connections, so server-side prepared statements
    // can't be reused). Both direct and pooled connection strings are supported.
    prepare: false,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_S,
    connect_timeout: CONNECT_TIMEOUT_S,
    max_lifetime: MAX_LIFETIME_S,
    // NOTE: no `connection: { statement_timeout }` here on purpose — Supavisor
    // transaction mode rejects unknown startup parameters (08P01), failing
    // every query. The 25s request-path cap lives as a role-level default
    // (see the header comment) so it applies on direct and pooled alike.
    ...options,
  });

  const observed = hooks?.onQuery ? instrumentSql(client as AnySql, hooks.onQuery) : client;
  return drizzle(observed as typeof client, { schema });
}

export type Database = ReturnType<typeof createDb>;
