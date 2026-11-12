/**
 * Channel isolation of the changelog feed collection.
 *
 * A channel-filtered `/changelog` reads only the feed its channel comes
 * from: `channel=stable` the GitHub Releases feed, `channel=dev` the Docker
 * Hub tags feed. An unrelated feed outage must not delay the response up to
 * its timeout, and a dev-only request must not spend the GitHub budget (60
 * reads per hour per egress IP, see version.test.ts).
 *
 * The router keeps its feed cache at module scope, so each probe advances the
 * clock past the TTL and counts the upstream calls in its own window
 * (`bun test --isolate` gives this file its own module copy).
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';

const RELEASES = [
  { tag_name: 'v1.0.0', name: 'v1.0.0', published_at: '2026-11-01T00:00:00Z', body: 'notes', draft: false, prerelease: false },
];
const TAGS = [{ name: 'dev-abc1234', last_updated: '2026-11-02T00:00:00Z' }];

let upstreamCalls: string[] = [];
const realFetch = globalThis.fetch;
const { versionRouter } = await import('./version');

beforeAll(() => {
  setSystemTime(new Date('2026-11-02T12:00:00Z'));
  globalThis.fetch = Object.assign((async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.github.com/')) {
      upstreamCalls.push('github');
      return Response.json(RELEASES);
    }
    if (url.startsWith('https://hub.docker.com/')) {
      upstreamCalls.push('dockerhub');
      return Response.json({ results: TAGS });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch, { preconnect: realFetch.preconnect });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

function advancePastTtl() {
  setSystemTime(new Date(Date.now() + 11 * 60_000));
}

test('a stable changelog fetches only the GitHub feed', async () => {
  advancePastTtl();
  upstreamCalls = [];
  const res = await versionRouter.request('/changelog?channel=stable');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ changelog: [
    { version: '1.0.0', channel: 'stable', date: '2026-11-01', title: 'v1.0.0', description: 'notes', changes: [] },
  ] });
  expect(upstreamCalls).toEqual(['github']);
});

test('a dev changelog fetches only the Docker Hub feed', async () => {
  advancePastTtl();
  upstreamCalls = [];
  const res = await versionRouter.request('/changelog?channel=dev');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ changelog: [
    { version: 'dev-abc1234', channel: 'dev', date: '2026-11-02', title: 'Dev build abc1234', sha: 'abc1234', description: '', changes: [] },
  ] });
  expect(upstreamCalls).toEqual(['dockerhub']);
});

test('an unknown channel fetches no feed and answers an empty changelog', async () => {
  advancePastTtl();
  upstreamCalls = [];
  const res = await versionRouter.request('/changelog?channel=nonsense');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ changelog: [] });
  expect(upstreamCalls).toEqual([]);
});
