/**
 * Real CLI process runs for `kortix gateway usage`: the actual `index.ts`
 * binary is spawned against a fake gateway API. Proves the legacy output is
 * untouched without new flags, the new query flags build the right request,
 * `--all` drains the cursor, and the three money concepts render separately.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

interface Captured {
  path: string;
  query: URLSearchParams;
}

interface Fake {
  url: string;
  requests: Captured[];
  stop: () => void;
}

/** A fake gateway API. `/gateway/usage` is paginated; legacy endpoints answer minimally. */
function fakeApi(pages: Record<string, unknown>[] = []): Fake {
  const requests: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ path: url.pathname, query: url.searchParams });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

      if (url.pathname.endsWith('/gateway/usage')) {
        const cursor = url.searchParams.get('cursor');
        const index = cursor ? Number(cursor) : 0;
        const page = pages[index] ?? {
          group_by: ['model'],
          window: { since: null, until: null, days: 7 },
          valuation: { coverage: 'estimate coverage line' },
          groups: [],
          totals: {
            kortix_cost: 0,
            provider_cost: 0,
            total_cost: 0,
            requests: 0,
            errors: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            estimated_usage_value: null,
            priced_requests: 0,
            unpriced_requests: 0,
            groups: 0,
          },
          next_cursor: null,
        };
        return json(page);
      }
      if (url.pathname.endsWith('/gateway/overview')) {
        return json({
          window_days: 7,
          requests: 1,
          errors: 0,
          total_cost: 0,
          kortix_cost: 0,
          provider_cost: 0,
          input_tokens: 0,
          output_tokens: 0,
          estimated_usage_value: null,
          valuation: {},
        });
      }
      if (url.pathname.endsWith('/gateway/breakdown')) return json({ window_days: 7, models: [] });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

async function cli(fake: Fake, args: string[]) {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts'), 'gateway', ...args], {
    env: {
      ...process.env,
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_API_URL: fake.url,
      KORTIX_TOKEN: 'person',
      KORTIX_PROJECT_ID: 'p1',
      KORTIX_SESSION_ID: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, out: stdout + stderr };
}

describe('kortix gateway usage (real process)', () => {
  test('no new flags → legacy path (overview+breakdown), never the query endpoint', async () => {
    const fake = fakeApi();
    try {
      const r = await cli(fake, ['usage', '--days', '7']);
      expect(r.code).toBe(0);
      const paths = fake.requests.map((x) => x.path);
      expect(paths.some((p) => p.endsWith('/gateway/overview'))).toBe(true);
      expect(paths.some((p) => p.endsWith('/gateway/usage'))).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test('--group-by builds the query request with since/until/group_by/limit', async () => {
    const fake = fakeApi();
    try {
      const r = await cli(fake, [
        'usage',
        '--group-by',
        'source,model',
        '--since',
        '2026-11-07T00:00:00Z',
        '--until',
        '2026-11-14T00:00:00Z',
        '--limit',
        '250',
        '--json',
      ]);
      expect(r.code).toBe(0);
      const call = fake.requests.find((x) => x.path.endsWith('/gateway/usage'));
      expect(call).toBeTruthy();
      expect(call!.query.get('group_by')).toBe('source,model');
      expect(call!.query.get('since')).toBe('2026-11-07T00:00:00Z');
      expect(call!.query.get('until')).toBe('2026-11-14T00:00:00Z');
      expect(call!.query.get('limit')).toBe('250');
    } finally {
      fake.stop();
    }
  });

  test('--json passes the server payload through verbatim', async () => {
    const fake = fakeApi([
      {
        group_by: ['model'],
        window: { since: null, until: null, days: 7 },
        valuation: { coverage: 'c' },
        groups: [
          {
            model: 'glm-5.3-flash',
            kortix_cost: 2.4,
            provider_cost: 0,
            total_cost: 2.4,
            requests: 3,
            errors: 0,
            input_tokens: 10,
            output_tokens: 5,
            cached_tokens: 1,
            cache_write_tokens: 0,
            estimated_usage_value: null,
            priced_requests: 0,
            unpriced_requests: 3,
            last_at: null,
          },
        ],
        totals: {
          kortix_cost: 2.4,
          provider_cost: 0,
          total_cost: 2.4,
          requests: 3,
          errors: 0,
          input_tokens: 10,
          output_tokens: 5,
          cached_tokens: 1,
          cache_write_tokens: 0,
          estimated_usage_value: null,
          priced_requests: 0,
          unpriced_requests: 3,
          groups: 1,
        },
        next_cursor: null,
      },
    ]);
    try {
      const r = await cli(fake, ['usage', '--group-by', 'model', '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.groups[0].model).toBe('glm-5.3-flash');
      expect(parsed.totals.kortix_cost).toBe(2.4);
    } finally {
      fake.stop();
    }
  });

  test('--all follows next_cursor and concatenates every page', async () => {
    const page = (cursor: string | null, model: string) => ({
      group_by: ['model'],
      window: { since: null, until: null, days: 7 },
      valuation: { coverage: 'c' },
      groups: [
        {
          model,
          kortix_cost: 1,
          provider_cost: 0,
          total_cost: 1,
          requests: 1,
          errors: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
          estimated_usage_value: null,
          priced_requests: 0,
          unpriced_requests: 0,
          last_at: null,
        },
      ],
      totals: {
        kortix_cost: 3,
        provider_cost: 0,
        total_cost: 3,
        requests: 3,
        errors: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        estimated_usage_value: null,
        priced_requests: 0,
        unpriced_requests: 0,
        groups: 3,
      },
      next_cursor: cursor,
    });
    // cursor '1' → page index 1, cursor '2' → index 2 (last).
    const fake = fakeApi([page('1', 'a'), page('2', 'b'), page(null, 'c')]);
    try {
      const r = await cli(fake, ['usage', '--group-by', 'model', '--all', '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.groups.map((g: { model: string }) => g.model)).toEqual(['a', 'b', 'c']);
      expect(parsed.next_cursor).toBeNull();
      const usageCalls = fake.requests.filter((x) => x.path.endsWith('/gateway/usage'));
      expect(usageCalls).toHaveLength(3);
    } finally {
      fake.stop();
    }
  });

  test('the human table labels paid wallet, BYOK provider and total separately', async () => {
    const fake = fakeApi([
      {
        group_by: ['model'],
        window: { since: null, until: null, days: 7 },
        valuation: { coverage: 'c' },
        groups: [
          {
            model: 'glm-5.3-flash',
            kortix_cost: 2.4,
            provider_cost: 0,
            total_cost: 2.4,
            requests: 3,
            errors: 0,
            input_tokens: 10,
            output_tokens: 5,
            cached_tokens: 1,
            cache_write_tokens: 0,
            estimated_usage_value: null,
            priced_requests: 0,
            unpriced_requests: 3,
            last_at: null,
          },
        ],
        totals: {
          kortix_cost: 2.4,
          provider_cost: 0.25,
          total_cost: 2.65,
          requests: 4,
          errors: 0,
          input_tokens: 10,
          output_tokens: 5,
          cached_tokens: 1,
          cache_write_tokens: 0,
          estimated_usage_value: null,
          priced_requests: 0,
          unpriced_requests: 4,
          groups: 1,
        },
        next_cursor: null,
      },
    ]);
    try {
      const r = await cli(fake, ['usage', '--group-by', 'model']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('PAID WALLET');
      expect(r.out).toContain('BYOK PROVIDER');
      expect(r.out).toContain('TOTAL');
      expect(r.out).toContain('not a bill');
    } finally {
      fake.stop();
    }
  });

  test('--all freezes the window: a rolling --days page-1 becomes absolute since/until on every later page', async () => {
    // The window the server resolved from --days 7, echoed back on page 1.
    const WIN = { since: '2026-11-06T12:00:00.000Z', until: '2026-11-13T12:00:00.000Z', days: 7 };
    const page = (model: string, next: string | null) => ({
      group_by: ['model'],
      window: WIN,
      valuation: { coverage: 'c' },
      groups: [
        {
          model,
          kortix_cost: 1,
          provider_cost: 0,
          total_cost: 1,
          requests: 1,
          errors: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
          estimated_usage_value: null,
          priced_requests: 0,
          unpriced_requests: 0,
          last_at: null,
        },
      ],
      totals: {
        kortix_cost: 3,
        provider_cost: 0,
        total_cost: 3,
        requests: 3,
        errors: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        estimated_usage_value: null,
        priced_requests: 0,
        unpriced_requests: 0,
        groups: 3,
      },
      next_cursor: next,
    });
    const fake = fakeApi([page('a', '1'), page('b', '2'), page('c', null)]);
    try {
      const r = await cli(fake, ['usage', '--group-by', 'model', '--days', '7', '--all', '--json']);
      expect(r.code).toBe(0);
      const usageCalls = fake.requests.filter((x) => x.path.endsWith('/gateway/usage'));
      expect(usageCalls).toHaveLength(3);
      // Page 1 used the rolling window.
      expect(usageCalls[0].query.get('days')).toBe('7');
      expect(usageCalls[0].query.get('since')).toBeNull();
      // Every later page is pinned to the ABSOLUTE window page 1 resolved, and
      // never re-sends the rolling `days` (which would drift under pagination).
      for (const call of usageCalls.slice(1)) {
        expect(call.query.get('days')).toBeNull();
        expect(call.query.get('since')).toBe(WIN.since);
        expect(call.query.get('until')).toBe(WIN.until);
      }
    } finally {
      fake.stop();
    }
  });

  test('--all refuses a repeating cursor instead of looping or truncating silently', async () => {
    // A buggy server that hands back the SAME cursor forever.
    const loop = {
      group_by: ['model'],
      window: { since: '2026-11-06T12:00:00.000Z', until: '2026-11-13T12:00:00.000Z', days: null },
      valuation: { coverage: 'c' },
      groups: [
        {
          model: 'a',
          kortix_cost: 1,
          provider_cost: 0,
          total_cost: 1,
          requests: 1,
          errors: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 0,
          estimated_usage_value: null,
          priced_requests: 0,
          unpriced_requests: 0,
          last_at: null,
        },
      ],
      totals: {
        kortix_cost: 1,
        provider_cost: 0,
        total_cost: 1,
        requests: 1,
        errors: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        estimated_usage_value: null,
        priced_requests: 0,
        unpriced_requests: 0,
        groups: 1,
      },
      next_cursor: 'LOOP',
    };
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify(loop), { headers: { 'content-type': 'application/json' } }),
    });
    const fake: Fake = {
      url: `http://127.0.0.1:${server.port}/v1`,
      requests: [],
      stop: () => server.stop(true),
    };
    try {
      const r = await cli(fake, [
        'usage',
        '--since',
        '2026-11-06T12:00:00Z',
        '--until',
        '2026-11-13T12:00:00Z',
        '--group-by',
        'model',
        '--all',
        '--json',
      ]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('repeating cursor');
    } finally {
      fake.stop();
    }
  });

  test('the --group alias also engages the query path (never a silent legacy fallback)', async () => {
    const fake = fakeApi();
    try {
      const r = await cli(fake, ['usage', '--group', 'model', '--json']);
      expect(r.code).toBe(0);
      const call = fake.requests.find((x) => x.path.endsWith('/gateway/usage'));
      expect(call?.query.get('group_by')).toBe('model');
      expect(fake.requests.some((x) => x.path.endsWith('/gateway/overview'))).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test('--all cannot be combined with --cursor', async () => {
    const fake = fakeApi();
    try {
      const r = await cli(fake, ['usage', '--group-by', 'model', '--all', '--cursor', 'x']);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('--all');
    } finally {
      fake.stop();
    }
  });
});
