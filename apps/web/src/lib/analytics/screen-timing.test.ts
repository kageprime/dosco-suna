/**
 * `screen_ready` timing: a screen is ready when its request chain settles
 * (no fetch for QUIET_MS), a marked screen when it says so. The event carries
 * the route template, never an id.
 */
import { describe, expect, test } from 'bun:test';

import { createScreenTimer, QUIET_MS, type ScreenReady } from './screen-timing';

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout: (id: unknown) => void timers.delete(id as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}

function setup() {
  const time = fakeClock();
  const events: ScreenReady[] = [];
  const timer = createScreenTimer(time.clock, (event) => events.push(event));
  return { time, events, timer };
}

const HOME = '/workspaces/9f0c1a2b-1111-4222-8333-944455556666';
const SESSION = `${HOME}/sessions/4a0c1a2b-1111-4222-8333-944455556666`;

describe('screen_ready', () => {
  test('a page load reports from navigation start to the last response of the chain', () => {
    const { time, events, timer } = setup();
    time.advance(400);
    timer.navigate(HOME, 2); // wave 1 already in flight when the host mounts
    time.advance(300);
    timer.queries(false, 0); // wave 1 done
    time.advance(100); // a gap shorter than QUIET_MS
    timer.queries(true, 1); // wave 2 starts
    time.advance(200);
    timer.queries(false, 0); // wave 2 done at 1000
    expect(events).toEqual([]);
    time.advance(QUIET_MS);
    expect(events).toEqual([
      { screen: '/workspaces/:id', duration_ms: 1000, navigation: 'load', fetches: 3 },
    ]);
  });

  test('a route change counts from the change; a screen with no fetch sends nothing', () => {
    const { time, events, timer } = setup();
    timer.navigate(HOME, 1);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    time.advance(5_000);
    timer.navigate(`${HOME}/settings`, 0); // everything cached
    time.advance(5_000);
    timer.navigate(`${HOME}/members`, 1);
    time.advance(250);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    expect(events.map((e) => [e.screen, e.navigation, e.duration_ms])).toEqual([
      ['/workspaces/:id', 'load', 0],
      ['/workspaces/:id/members', 'route', 250],
    ]);
  });

  test('a load that redirects before it is ready stays a load on the screen it lands on', () => {
    const { time, events, timer } = setup();
    timer.navigate(HOME, 1);
    time.advance(200);
    timer.navigate(`${HOME}/chat`, 1);
    time.advance(600);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    expect(events).toEqual([
      { screen: '/workspaces/:id/chat', duration_ms: 800, navigation: 'load', fetches: 1 },
    ]);
  });

  test('the session screen reports only when marked, however long it polls', () => {
    const { time, events, timer } = setup();
    timer.navigate(SESSION, 2);
    time.advance(300);
    timer.queries(false, 0);
    time.advance(QUIET_MS * 4);
    expect(events).toEqual([]);
    timer.mark(SESSION, 1);
    expect(events).toEqual([
      { screen: '/workspaces/:id/sessions/:id', duration_ms: 2300, navigation: 'load', fetches: 2 },
    ]);
  });

  test('a mark that runs before the host sees the route still measures that route', () => {
    const { time, events, timer } = setup();
    timer.navigate(HOME, 1);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    time.advance(1_000);
    timer.mark(SESSION, 0); // the page effect runs before the host effect
    timer.navigate(SESSION, 0); // the host effect: same path, no new measurement
    expect(events.at(-1)).toEqual({
      screen: '/workspaces/:id/sessions/:id',
      duration_ms: 0,
      navigation: 'route',
      fetches: 0,
    });
    expect(events).toHaveLength(2);
  });

  test('a hidden tab or a screen slower than a minute sends nothing', () => {
    const { time, events, timer } = setup();
    timer.navigate(HOME, 1);
    timer.abandon();
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    timer.navigate(`${HOME}/members`, 1);
    time.advance(61_000);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    expect(events).toEqual([]);
  });

  test('a marketing or auth page sends nothing, and the app screen after it counts as a route', () => {
    const { time, events, timer } = setup();
    timer.navigate('/auth', 1);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    time.advance(2_000);
    timer.navigate(HOME, 1);
    time.advance(400);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    expect(events).toEqual([
      { screen: '/workspaces/:id', duration_ms: 400, navigation: 'route', fetches: 1 },
    ]);
  });

  test('a mark on a screen that is not marked is ignored', () => {
    const { time, events, timer } = setup();
    timer.navigate(HOME, 1);
    timer.mark(HOME, 1);
    expect(events).toEqual([]);
    timer.queries(false, 0);
    time.advance(QUIET_MS);
    expect(events).toHaveLength(1);
  });
});
