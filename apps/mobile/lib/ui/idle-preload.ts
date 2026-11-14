/**
 * idle-preload — evaluate modules ahead of their first use, one per idle
 * slice of the JS thread.
 *
 * Metro bundles this app with `inlineRequires: false`: requiring a module
 * evaluates its whole import graph at once. The project's drawer pages
 * (Files, Review, Apps, Artifacts, Sessions, Notifications, Account) are
 * required on their first render, so the first tap on each one paid for its
 * graph inside the tap. ProjectScreen preloads them here once the project
 * has settled, so the tap only renders.
 *
 * One loader per idle callback: the JS thread is never held for the whole
 * list at once, and a tap waits at most for the one module in progress.
 * A loader that throws is skipped: its page then loads on first render, as
 * before.
 */

/** The scheduler `preloadWhenIdle` uses. Injectable for tests. */
export interface IdleScheduler {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  requestIdleCallback: (callback: () => void) => unknown;
  cancelIdleCallback: (handle: unknown) => void;
}

const globalScheduler = (): IdleScheduler => {
  const g = globalThis as unknown as {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => unknown;
    cancelIdleCallback?: (handle: unknown) => void;
  };
  // React Native implements `requestIdleCallback` on its JS timers. A host
  // without it (bun test, web) gets a plain timeout.
  const ric = g.requestIdleCallback;
  const cic = g.cancelIdleCallback;
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    requestIdleCallback: ric
      ? (callback) => ric(callback, { timeout: IDLE_TIMEOUT_MS })
      : (callback) => setTimeout(callback, 0),
    cancelIdleCallback: cic
      ? (handle) => cic(handle)
      : (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
};

/** The longest one loader waits for an idle slice before it runs anyway. */
export const IDLE_TIMEOUT_MS = 2_000;

/**
 * Run each loader in its own idle slice, starting `delayMs` from now.
 * Returns a cancel function: the loaders not yet run never run.
 */
export function preloadWhenIdle(
  loaders: ReadonlyArray<() => unknown>,
  delayMs: number,
  scheduler: IdleScheduler = globalScheduler()
): () => void {
  let index = 0;
  let cancelled = false;
  let timeout: unknown = null;
  let idle: unknown = null;

  const next = () => {
    idle = null;
    if (cancelled || index >= loaders.length) return;
    const load = loaders[index++];
    try {
      load();
    } catch {
      // The page loads on its first render instead.
    }
    if (index < loaders.length) idle = scheduler.requestIdleCallback(next);
  };

  timeout = scheduler.setTimeout(() => {
    timeout = null;
    if (!cancelled) idle = scheduler.requestIdleCallback(next);
  }, delayMs);

  return () => {
    cancelled = true;
    if (timeout !== null) scheduler.clearTimeout(timeout);
    if (idle !== null) scheduler.cancelIdleCallback(idle);
  };
}
