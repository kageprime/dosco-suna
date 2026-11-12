/**
 * The dial-dead mark (`forward/dial-dead.ts`): two consecutive connect
 * timeouts make a box a candidate, but only an HTTP probe through the ingress
 * that receives NO answer confirms it — the proxy's connect timer bounds the
 * header phase too, so a healthy-but-slow handler must never mark, and an
 * HTTPS provider edge accepts TCP whatever the box behind it does, so only a
 * settled HTTP response (any status) proves the path alive. The probe dials a
 * liveness path, never the request's own route: one hung route must never be
 * able to answer the probe for its healthy siblings. After confirmation every
 * request fails fast without dialling, one request per probe window dials
 * again, and any answered dial clears the mark.
 *
 * KRTX-4459: a session box whose daemon died on a running box answered no
 * request, and every client poll walked the proxy's full ~50 s retry ladder
 * before the give-up 502 — ~5% of a small hour's rows read 45-50 s and the
 * route's p95 read 15-45 s while its p50 stayed at ~90 ms.
 */
import { describe, expect, test } from 'bun:test';
import {
  DIAL_DEAD_AFTER_TIMEOUTS,
  DIAL_DEAD_PROBE_SPACING_MS,
  DIAL_DEAD_STREAK_WINDOW_MS,
  DIAL_LIVENESS_PATH,
  DIAL_PROBE_TIMEOUT_MS,
  __resetDialDeadForTests,
  __setDialProbeBudgetForTests,
  __setDialProbeForTests,
  clearDialDead,
  dialDeadKey,
  maybeProbeDialDeadCandidate,
  probeTarget,
  recordDialTimeout,
  shouldFailFast,
} from './dial-dead';
import { PROXY_ATTEMPT_TIMEOUT_MS } from '../preview-retry-budget';

const T0 = 1_700_000_000_000;
const key = dialDeadKey('sbx-dead', 8000);
const target = { url: 'https://box-ingress.test/kortix/runtime/pending', headers: { authorization: 'Bearer k' } };
const unanswered = async () => false;
const answered = async () => true;

describe('the dial-dead streak', () => {
  test(`one timeout never marks (the stale-ingress case the ladder recovers from)`, async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    await maybeProbeDialDeadCandidate(key, target);
    expect(shouldFailFast(key, T0 + 1)).toBe(false);
    recordDialTimeout(key, T0 + DIAL_DEAD_STREAK_WINDOW_MS + 1);
    await maybeProbeDialDeadCandidate(key, target);
    expect(shouldFailFast(key, T0 + DIAL_DEAD_STREAK_WINDOW_MS + 2)).toBe(false);
  });

  test('two timeouts make a candidate, but an unanswered probe is what confirms', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    expect(shouldFailFast(key, T0 + 1_001)).toBe(false);
    await maybeProbeDialDeadCandidate(key, target, T0 + 1_001);
    expect(shouldFailFast(key, T0 + 1_002)).toBe(true);
  });

  test('a probe that receives an answer clears the streak — a slow handler never poisons the port', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(answered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    await maybeProbeDialDeadCandidate(key, target);
    expect(shouldFailFast(key, T0 + 1_002)).toBe(false);
    // The cleared streak starts over: one more timeout is again only a candidate.
    recordDialTimeout(key, T0 + 2_000);
    await maybeProbeDialDeadCandidate(key, target);
    expect(shouldFailFast(key, T0 + 2_001)).toBe(false);
  });

  test('a timeout outside the streak window starts a new streak', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + DIAL_DEAD_STREAK_WINDOW_MS + 1);
    await maybeProbeDialDeadCandidate(key, target);
    expect(shouldFailFast(key, T0 + DIAL_DEAD_STREAK_WINDOW_MS + 2)).toBe(false);
  });

  test('an answered dial clears the mark', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    await maybeProbeDialDeadCandidate(key, target, T0 + 1_001);
    clearDialDead(key);
    expect(shouldFailFast(key, T0 + 1_002)).toBe(false);
  });

  test('concurrent callers share one probe', async () => {
    __resetDialDeadForTests();
    let probeCalls = 0;
    let release!: (answered: boolean) => void;
    __setDialProbeForTests(() => {
      probeCalls += 1;
      return new Promise<boolean>((resolve) => (release = resolve));
    });
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    const first = maybeProbeDialDeadCandidate(key, target);
    const second = maybeProbeDialDeadCandidate(key, target);
    expect(probeCalls).toBe(1);
    release(false);
    await Promise.all([first, second]);
    expect(shouldFailFast(key, T0 + 1_002)).toBe(true);
  });

  // The reviewer's regression (2026-11-12, sixth cut): a probe in flight
  // settles against the EPISODE it asked about. A successful dial clears that
  // episode and a single new timeout opens a fresh one — one timeout alone
  // must never confirm, so the stale probe's silence must NOT confirm the
  // replacement (before the fence, it read the fresh mark and confirmed it:
  // shouldFailFast false -> true).
  test('a stale probe never confirms a replacement one-timeout episode', async () => {
    __resetDialDeadForTests();
    const releases: Array<(answered: boolean) => void> = [];
    __setDialProbeForTests(
      () =>
        new Promise<boolean>((resolve) => {
          releases.push(resolve);
        }),
    );
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    // The probe flies, unsettled, against the two-timeout episode.
    const stale = maybeProbeDialDeadCandidate(key, target);
    expect(shouldFailFast(key, T0 + 1_001)).toBe(false);
    // A concurrent dial succeeds (the box answered): the episode clears...
    clearDialDead(key);
    // ...and the box degrades again: ONE new timeout, a fresh one-timeout
    // episode that must wait for a probe of its own.
    recordDialTimeout(key, T0 + 2_000);
    expect(shouldFailFast(key, T0 + 2_001)).toBe(false);
    // The stale probe settles with silence. Fenced: it says nothing about the
    // replacement episode.
    releases[0]!(false);
    await stale;
    expect(shouldFailFast(key, T0 + 2_002)).toBe(false);
    // The replacement episode needs a second timeout (one never spawns a
    // probe) and then confirms only when its OWN probe settles silent.
    recordDialTimeout(key, T0 + 2_500);
    expect(shouldFailFast(key, T0 + 2_501)).toBe(false);
    const own = maybeProbeDialDeadCandidate(key, target, T0 + 2_501);
    releases[1]!(false);
    await own;
    expect(shouldFailFast(key, T0 + 2_502)).toBe(true);
  });
});

describe('the probe slot of a confirmed mark', () => {
  test('every request inside the window fails fast without dialling', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    await maybeProbeDialDeadCandidate(key, target, T0 + 1_001);
    expect(shouldFailFast(key, T0 + 2_000)).toBe(true);
    expect(shouldFailFast(key, T0 + 60_000)).toBe(true);
  });

  test('exactly one request per probe window dials again, then the window holds', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    await maybeProbeDialDeadCandidate(key, target, T0 + 1_001);
    expect(shouldFailFast(key, T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS)).toBe(false);
    expect(shouldFailFast(key, T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS + 1)).toBe(true);
  });

  test('a re-probe dial timing out does not un-confirm the mark', async () => {
    __resetDialDeadForTests();
    __setDialProbeForTests(unanswered);
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    await maybeProbeDialDeadCandidate(key, target, T0 + 1_001);
    // The window expires and hands out the re-probe slot; the re-probe dial
    // times out too. The timeout alone never un-confirms: the mark and the
    // window hold, so the requests after the re-probe still fail fast. What
    // may clear the mark is the slot's own independent liveness revalidation
    // (the two real-server tests below), never the timeout.
    expect(shouldFailFast(key, T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS)).toBe(false);
    recordDialTimeout(key, T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS + 10_000);
    expect(shouldFailFast(key, T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS + 10_001)).toBe(true);
    expect(shouldFailFast(key, T0 + 1_001 + 2 * DIAL_DEAD_PROBE_SPACING_MS + 10_000)).toBe(false);
  });
});

describe('the real HTTP probe against real servers', () => {
  // The probe URL exactly as the retry wiring builds it: the ingress base plus
  // the liveness path, never the request's route.
  const probeUrlOn = (serverUrl: string | URL) => `${serverUrl}`.replace(/\/$/, '') + DIAL_LIVENESS_PATH;

  // The reviewer's topology (2026-11-11): the ingress is a live edge, so a TCP
  // connect always succeeds even when the box behind it answers nothing. The
  // REAL probe — no stub — must read the topology through the HTTP response.
  test('a hanging handler behind an accepting connection is dial-dead', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(1_000);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // accepts, never answers
    });
    try {
      recordDialTimeout(key, T0);
      recordDialTimeout(key, T0 + 1_000);
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} });
      expect(shouldFailFast(key, T0 + 2_000)).toBe(true);
    } finally {
      server.stop(true);
      __resetDialDeadForTests();
    }
  });

  // The reviewer's regression (2026-11-12): one hung route must never poison
  // the port. A probe of the hung route's own URL hangs WITH it and confirms
  // the mark against a box whose other routes answer fine — every later read
  // on the port then fails fast while /health serves 200. The probe asks the
  // liveness path instead: the live server answers it (a fast 404 is an
  // answer), so the streak clears and the hung route keeps today's ladder
  // alone.
  test('one hung route never marks the port: the probe is path-independent', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(1_000);
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === '/slow') return new Promise<Response>(() => {}); // hangs forever
        return new Response('ok'); // /health and the liveness path answer from the same server
      },
    });
    try {
      recordDialTimeout(key, T0);
      recordDialTimeout(key, T0 + 1_000);
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} });
      expect(shouldFailFast(key, T0 + 2_000)).toBe(false);
    } finally {
      server.stop(true);
      __resetDialDeadForTests();
    }
  });

  test('a handler that answers within the probe budget is alive', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(3_000);
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(200); // answers later than the attempt timer would like, within the probe budget
        return new Response('late');
      },
    });
    try {
      recordDialTimeout(key, T0);
      recordDialTimeout(key, T0 + 1_000);
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} });
      expect(shouldFailFast(key, T0 + 2_000)).toBe(false);
    } finally {
      server.stop(true);
      __resetDialDeadForTests();
    }
  });

  test('a refused connection is dial-dead', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(1_000);
    const server = Bun.serve({ port: 0, fetch: () => new Response('up') });
    const url = server.url;
    server.stop(true); // nothing listens there any more
    recordDialTimeout(key, T0);
    recordDialTimeout(key, T0 + 1_000);
    await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(url), headers: {} });
    expect(shouldFailFast(key, T0 + 2_000)).toBe(true);
  });

  test('the real probe answers what an HTTP response answers, and nothing else', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(1_000);
    const server = Bun.serve({ port: 0, fetch: () => new Response('up', { status: 503 }) });
    try {
      expect(await probeTarget({ url: `${server.url}x`, headers: {} })).toBe(true);
    } finally {
      server.stop(true);
      __resetDialDeadForTests();
    }
  });

  // The reviewer's regression (2026-11-12, fifth cut): once confirmed, the mark
  // must not ride on the old confirmation forever. A box the relaunch revived
  // answers every route EXCEPT the polled one, which stays wedged — its re-probe
  // dial then times out every window, recordDialTimeout keeps the confirmation,
  // and (before this fix) no liveness probe ever ran again: /health served 200
  // while every read on the port still fast-failed. The slot's probe call must
  // revalidate the mark on the liveness path: the revived box's HTTP layer
  // answers it, the mark clears, the siblings are served again.
  test('a revived box clears on the re-probe slot: the slot revalidates the mark on the liveness path', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(1_000);
    let revived = false;
    const answeredPaths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const pathname = new URL(req.url).pathname;
        if (!revived || pathname === '/polled') return new Promise<Response>(() => {}); // dead — or the wedged polled route
        answeredPaths.push(pathname);
        return new Response('ok'); // the revived box's HTTP layer answers everything else
      },
    });
    try {
      // The box's whole HTTP path hangs: the streak confirms on the silent probe.
      recordDialTimeout(key, T0);
      recordDialTimeout(key, T0 + 1_000);
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} }, T0 + 1_001);
      expect(shouldFailFast(key, T0 + 2_000)).toBe(true);
      // The box revives. The window expires and hands out the re-probe slot;
      // the slot's dial times out on the wedged route, and the slot's probe
      // call — not the old confirmation — must settle the mark.
      revived = true;
      const slotAt = T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS;
      expect(shouldFailFast(key, slotAt)).toBe(false); // this request dials again
      recordDialTimeout(key, slotAt + PROXY_ATTEMPT_TIMEOUT_MS); // its dial timed out on /polled
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} }, slotAt);
      // The liveness path answered: the mark cleared, the siblings are served.
      expect(shouldFailFast(key, slotAt + PROXY_ATTEMPT_TIMEOUT_MS + 1)).toBe(false);
      expect(answeredPaths).toContain(DIAL_LIVENESS_PATH);
    } finally {
      server.stop(true);
      __resetDialDeadForTests();
    }
  });

  // The dead-box side of the same slot: silence on the revalidation keeps the
  // mark and its window — a still-dead box gains one detached probe per window
  // and nothing else.
  test('a still-dead box keeps the mark through the slot revalidation', async () => {
    __resetDialDeadForTests();
    __setDialProbeBudgetForTests(1_000);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // accepts, never answers
    });
    try {
      recordDialTimeout(key, T0);
      recordDialTimeout(key, T0 + 1_000);
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} }, T0 + 1_001);
      const slotAt = T0 + 1_001 + DIAL_DEAD_PROBE_SPACING_MS;
      expect(shouldFailFast(key, slotAt)).toBe(false);
      recordDialTimeout(key, slotAt + PROXY_ATTEMPT_TIMEOUT_MS); // the re-probe dial timed out
      await maybeProbeDialDeadCandidate(key, { url: probeUrlOn(server.url), headers: {} }, slotAt);
      expect(shouldFailFast(key, slotAt + PROXY_ATTEMPT_TIMEOUT_MS + 1)).toBe(true);
    } finally {
      server.stop(true);
      __resetDialDeadForTests();
    }
  });
});

test('constants keep their contract', () => {
  expect(DIAL_DEAD_AFTER_TIMEOUTS).toBe(2);
  // The probe budget exceeds one attempt timer (the header wait that forms the
  // streak), so a handler that answers late is served by the probe; it stays
  // inside the streak window.
  expect(DIAL_PROBE_TIMEOUT_MS).toBeGreaterThan(PROXY_ATTEMPT_TIMEOUT_MS);
  expect(DIAL_PROBE_TIMEOUT_MS).toBeLessThan(DIAL_DEAD_STREAK_WINDOW_MS);
});
