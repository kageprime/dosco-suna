/**
 * Default postgres.js main-pool limit for one Kortix API process.
 *
 * 5 (2026-09-27 incident): one connection of the former 6 was silently spent
 * by the base-move LISTEN/NOTIFY subscription (`apps/api/src/shared/pg-broadcast.ts`),
 * which `database-capacity.ts` did not count — the same deploy produced
 * SQLSTATE `53300` until the ceiling counted every pool.
 *
 * 7 (this raise): raised inside the request-concurrency budget. The budget is
 * the rolling-deployment envelope in `apps/api/src/shared/database-capacity.ts`:
 * 10 tasks × 2× rolling overlap × (7 + 2 + 1 + 1) = 222 ≤ 227 API connections
 * (237 usable minus the 10 non-API reserve). Keep this pool at 7; the next
 * raise does not fit the current budget and needs the infra lane.
 */
export const DEFAULT_DB_POOL_MAX = 7;
