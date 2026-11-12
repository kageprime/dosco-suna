import { isUnder } from './procs';

/**
 * `sweep`: delete build output in idle checkouts. Build output is the largest
 * single lever: Next/Turbopack `.next` grows without bound under `next dev`
 * (3.4 GB and 7.0 GB in two checkouts on 2026-11-10) and Rust `target` dirs
 * run 2–35 GB. A removed worktree frees its build output plus ~1.3 GB of
 * unshared files; its 5.6 GB node_modules is mostly hardlinks into the pnpm
 * store and frees little. `autoclean` (lib/autoclean.ts) runs both on its own.
 */
export const ARTIFACT_DIRS = ['.next', '.turbo', 'dist', 'target', 'test-results', 'playwright-report'];

/**
 * A checkout is busy when any process runs inside it or names it on its
 * command line. The path must end at a separator, so `…/suna` does not match
 * `…/suna-rooms`.
 */
export function sweepBusy(dir: string, cwds: string[], commands: string[]): boolean {
  const d = dir.replace(/\/+$/, '');
  const named = new RegExp(`${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/\\s'"]|$)`);
  return cwds.some((c) => isUnder(c, d)) || commands.some((c) => named.test(c));
}
