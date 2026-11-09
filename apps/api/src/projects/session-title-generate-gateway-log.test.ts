/**
 * Regression guard for the phantom-5xx signal on `POST /v1/projects/:id/sessions`.
 *
 * The request-completion middleware (`src/index.ts`) owns the top-level `status`
 * field on a log line: it is THIS API's response status. The Better Stack
 * log-anomaly sweep counts every line with `status >= 500` as a 5xx response on
 * the route the line carries. `generateViaGateway` used to log the UPSTREAM
 * gateway's status as `{ status: res.status, model }`, so a handled
 * title-generation fallback (gateway 503) was counted as a 503 response of the
 * session-create route: 282 phantom 5xx in 12 h, against 3 real ones.
 *
 * The upstream status is logged as `upstream_status`. A line with no `status`
 * field is never counted as a request.
 */
import { describe, expect, it, mock } from 'bun:test';

process.env.LLM_GATEWAY_PROXY_TARGET = 'http://127.0.0.1:59999';
process.env.SESSION_TITLE_GENERATION_ENABLED = 'true';

interface Logged {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}
const logged: Logged[] = [];
const record =
  (level: string) =>
  (message: string, context?: Record<string, unknown>): void => {
    logged.push({ level, message, context });
  };

mock.module('../lib/logger', () => ({
  logger: {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  },
  isLoggingTransportError: () => false,
}));

const { generateSessionTitleFromFirstPrompt } = await import('./session-title-generate');

// A row that still needs a title (no name / custom_name).
const row = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  metadata: { model: 'codex/gpt-6-sol' },
} as never;

const INPUT = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  userId: 'user-1',
  firstPromptText: 'Please set up the MS Graph OAuth2 connector',
};

describe('title-generate gateway log fields', () => {
  it('logs the upstream gateway status as upstream_status, never as the request status', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream unavailable', { status: 503 })) as unknown as typeof fetch;
    try {
      await generateSessionTitleFromFirstPrompt(INPUT, {
        loadRow: async () => row,
        mintKey: async () => ({ secret: 'sk', keyId: 'key-1' }),
        revokeKey: async () => {},
        persist: async () => {},
        // No retry model: one gateway attempt, one warn.
        fallbackModel: async () => null,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    const warn = logged.find((l) => l.message === '[title-generate] gateway returned non-200');
    expect(warn).toBeDefined();
    expect(warn?.context?.upstream_status).toBe(503);
    // The load-bearing assertion: without a top-level `status`, the sweep reads
    // this warn as a log line, not as a 5xx response.
    expect(warn?.context).not.toHaveProperty('status');
  });

  // KRTX-4500: a Claude-subscription-only account (free tier, gateway-disabled
  // project) has no gateway model to spend, and the designed deterministic
  // prompt-excerpt title fires on EVERY session create. Both outcomes logged
  // at warn — one 29-session burst produced 58 warns (65x baseline) and the
  // log sweep filed two spike issues. They are expected states: info.
  it('logs the designed no-model / fallback outcomes at info, never warn', async () => {
    logged.length = 0;
    const noModelRow = {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      accountId: 'acct-1',
      metadata: {},
    } as never;
    await generateSessionTitleFromFirstPrompt(INPUT, {
      loadRow: async () => noModelRow,
      mintKey: async () => ({ secret: 'sk', keyId: 'key-1' }),
      revokeKey: async () => {},
      persist: async () => {},
      fallbackModel: async () => null,
    });

    const levelsOf = (message: string) =>
      logged.filter((l) => l.message === message).map((l) => l.level);
    expect(levelsOf('[title-generate] no servable model to title with')).toEqual(['info']);
    expect(levelsOf('[title-generate] using deterministic prompt fallback')).toEqual(['info']);
    // No warn at all on this path: nothing failed.
    expect(logged.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('makes ONE gateway call when the refusal is deterministic and no other model can serve', async () => {
    logged.length = 0;
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    }) as unknown as typeof fetch;
    const persisted: string[] = [];
    try {
      await generateSessionTitleFromFirstPrompt(INPUT, {
        loadRow: async () => row,
        mintKey: async () => ({ secret: 'sk', keyId: 'key-1' }),
        revokeKey: async () => {},
        persist: async (_r, title) => {
          persisted.push(title);
        },
        fallbackModel: async () => null,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    // At base the same model was retried and 400'd again: a second doomed call
    // (90 doubled 400s in 7 prod days — a 400 never succeeds twice).
    expect(calls).toBe(1);
    // The designed excerpt still titles the session.
    expect(persisted).toEqual(['Please set up the MS Graph OAuth2 connector']);
    // The refusal itself stays a warn — once, not twice.
    expect(logged.filter((l) => l.message === '[title-generate] gateway returned non-200')).toHaveLength(1);
  });

  it('still retries the same model on a TRANSIENT gateway state and titles from it', async () => {
    logged.length = 0;
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('unavailable', { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Set Up MS Graph' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const persisted: string[] = [];
    try {
      await generateSessionTitleFromFirstPrompt(INPUT, {
        loadRow: async () => row,
        mintKey: async () => ({ secret: 'sk', keyId: 'key-1' }),
        revokeKey: async () => {},
        persist: async (_r, title) => {
          persisted.push(title);
        },
        fallbackModel: async () => null,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toBe(2);
    expect(persisted).toEqual(['Set Up MS Graph']);
  });
});
