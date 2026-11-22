/**
 * `screen_ready`: how long a screen takes to show its data. PostHog adds the
 * country, so the same chart shows whether people far from our London API
 * wait longer. One event per navigation, sent through `track`. App screens
 * only (`isPrivatePath`): Vercel Speed Insights measures marketing and auth
 * pages.
 *
 * A screen is ready when React Query has had no request in flight for
 * `QUIET_MS`, after at least one request: the chain of API reads behind the
 * screen has settled. The event reports when the last request ended, not when
 * the quiet window ran out. A screen in `MARKED_SCREENS` keeps requests in
 * flight on purpose (the session screen polls while its sandbox wakes), so it
 * reports through `markScreenReady` instead.
 *
 * `navigation`: `load` counts from the browser's navigation start (HTML, JS,
 * auth and API reads). `route` counts from the in-app route change. A load
 * that redirects before it is ready (workspace home → its channel) stays a
 * `load` on the screen it lands on. A hidden tab ends the measurement without
 * an event: background tabs run timers late.
 */

import { isPrivatePath, routeTemplate } from './posthog-config';

export const QUIET_MS = 500;
export const MAX_MS = 60_000;
/** Route templates that report through `markScreenReady`, never the request settle. */
export const MARKED_SCREENS: ReadonlySet<string> = new Set(['/workspaces/:id/sessions/:id']);

export type ScreenReady = {
  /** The route template (`/workspaces/:id`): ids never leave the browser. */
  screen: string;
  duration_ms: number;
  navigation: 'load' | 'route';
  /** React Query fetches during the measurement. */
  fetches: number;
};

export type ScreenClock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

type Measurement = {
  screen: string;
  start: number;
  navigation: ScreenReady['navigation'];
  fetches: number;
  inFlight: number;
  quietTimer: unknown;
};

export type ScreenTimer = ReturnType<typeof createScreenTimer>;

export function createScreenTimer(clock: ScreenClock, emit: (event: ScreenReady) => void) {
  let current: Measurement | null = null;
  let lastPath: string | null = null;
  let loadOpen = true;

  const stopQuiet = () => {
    if (current?.quietTimer != null) clock.clearTimeout(current.quietTimer);
    if (current) current.quietTimer = null;
  };

  const finish = (at: number) => {
    const done = current;
    stopQuiet();
    current = null;
    if (!done) return;
    if (done.navigation === 'load') loadOpen = false;
    const duration = Math.round(at - done.start);
    if (duration < 0 || duration > MAX_MS) return;
    emit({ screen: done.screen, duration_ms: duration, navigation: done.navigation, fetches: done.fetches });
  };

  const settle = () => {
    if (!current || MARKED_SCREENS.has(current.screen)) return;
    if (current.inFlight > 0 || current.fetches === 0 || current.quietTimer != null) return;
    const endedAt = clock.now();
    current.quietTimer = clock.setTimeout(() => finish(endedAt), QUIET_MS);
  };

  return {
    /** A route change, or the first route of the page. The same path twice is one navigation. */
    navigate(pathname: string, inFlight: number) {
      if (pathname === lastPath) return;
      lastPath = pathname;
      stopQuiet();
      if (!isPrivatePath(pathname)) {
        current = null;
        loadOpen = false;
        return;
      }
      const navigation = loadOpen ? 'load' : 'route';
      current = {
        screen: routeTemplate(pathname),
        start: navigation === 'load' ? 0 : clock.now(),
        navigation,
        fetches: inFlight,
        inFlight,
        quietTimer: null,
      };
      settle();
    },
    /** Every React Query cache change: `started` when a fetch began, `inFlight` after it. */
    queries(started: boolean, inFlight: number) {
      if (!current) return;
      if (started) current.fetches += 1;
      current.inFlight = inFlight;
      if (inFlight > 0) stopQuiet();
      else settle();
    },
    /** A marked screen shows its data. Ignored on any other screen. */
    mark(pathname: string, inFlight: number) {
      this.navigate(pathname, inFlight);
      if (current && MARKED_SCREENS.has(current.screen)) finish(clock.now());
    },
    /** The tab went to the background: drop the measurement, send nothing. */
    abandon() {
      stopQuiet();
      // A tab that was hidden has no honest load time left to report.
      loadOpen = false;
      current = null;
    },
  };
}

let shared: ScreenTimer | null = null;
let readInFlight: () => number = () => 0;

/** The page's one timer. `inFlight` reads React Query's fetch count (`ScreenTimingHost`). */
export function screenTimer(
  emit: (event: ScreenReady) => void,
  inFlight?: () => number,
): ScreenTimer {
  if (inFlight) readInFlight = inFlight;
  shared ??= createScreenTimer(
    {
      now: () => performance.now(),
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
    },
    emit,
  );
  return shared;
}

/** A marked screen (`MARKED_SCREENS`) calls this when its data is on screen. */
export function markScreenReady(): void {
  if (typeof window === 'undefined' || !shared) return;
  if (document.visibilityState === 'hidden') {
    shared.abandon();
    return;
  }
  shared.mark(window.location.pathname, readInFlight());
}
