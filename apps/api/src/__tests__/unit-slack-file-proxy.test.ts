import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { SlackReadDeps } from '../connectors/slack-visibility';

// The proxy's retry pauses (400 ms, Retry-After seconds) are real `Bun.sleep`
// calls; which fetches the retries make is under test, not how long they wait.
const realSleep = Bun.sleep;
const shortSleep = spyOn(Bun, 'sleep').mockImplementation(((ms: number) => realSleep(Math.min(Number(ms), 10))) as typeof Bun.sleep);
afterAll(() => shortSleep.mockRestore());

mock.module('../channels/install-store', () => ({
  loadSlackBotIdForProject: async () => null,
  ensureSlackBotId: async () => null,
  loadSlackTokenForProject: async () => 'xoxb-test',
}));

const { downloadSlackFile } = await import('../channels/slack/file-proxy');
const { MAX_DOWNLOAD_BYTES } = await import('../channels/core/download');

// `slack download` is confined like a `file_info` read (slack-visibility.ts):
// only the Kortix workspace holding the Slack workspace downloads, and a file
// shared only in private conversations needs the person in one of them.
const FILE_URL = 'https://files.slack.com/files-pri/T0SYNTH01-F0SYNTH01/download/report.pdf';

/** The linked Slack workspace: G0FIN is private and the person is in it, G0EXEC private and they are not. */
let linked = true;
const slack: SlackReadDeps = {
  link: async () => (linked ? { teamId: 'T0SYNTH01' } : null),
  view: async () => ({ privateIds: new Set(['G0FIN', 'G0EXEC']), allowedIds: new Set(['G0FIN']), hasPerson: true }),
};

let sharedIn: string[] = ['C0PUBLIC'];
let sharedPrivately: string[] = [];
let body: Uint8Array = new Uint8Array(8);
let lengthHeader = true;
let fetches: string[] = [];
/** What the mocked files host answers with, in order; the last repeats. Empty
 * = the default 200 body below. Built fresh per fetch: a Response body reads
 * once. */
let fileResponses: Array<{ status: number; body?: BodyInit; headers?: Record<string, string> }> = [];
let fetchThrows = false;
const realFetch = globalThis.fetch;
beforeEach(() => {
  linked = true;
  sharedIn = ['C0PUBLIC'];
  sharedPrivately = [];
  body = new Uint8Array(8);
  lengthHeader = true;
  fetches = [];
  fileResponses = [];
  fetchThrows = false;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    fetches.push(url);
    if (url === 'https://slack.com/api/files.info') {
      return Response.json({ ok: true, file: { id: 'F0SYNTH01', channels: sharedIn, groups: sharedPrivately, ims: [] } });
    }
    if (fetchThrows) throw new Error('connection reset');
    if (fileResponses.length > 0) {
      const spec = fileResponses.length > 1 ? fileResponses.shift()! : fileResponses[0];
      return new Response(spec.body ?? null, { status: spec.status, headers: spec.headers });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      { headers: { 'content-type': 'application/pdf', ...(lengthHeader ? { 'content-length': String(body.byteLength) } : {}) } },
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('downloadSlackFile confinement', () => {
  test('a file shared in a public channel downloads', async () => {
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.byteLength).toBe(8);
    expect(fetches).toEqual(['https://slack.com/api/files.info', FILE_URL]);
  });

  test('a file shared only in a private channel the person is in downloads', async () => {
    sharedIn = [];
    sharedPrivately = ['G0FIN'];
    expect((await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack)).ok).toBe(true);
  });

  test('a file shared only in a private channel the person is not in is refused 403 and never fetched', async () => {
    sharedIn = [];
    sharedPrivately = ['G0EXEC'];
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r).toEqual({
      ok: false,
      status: 403,
      error: 'Slack file F0SYNTH01 is shared only in private conversations the person this session works for is not in.',
    });
    expect(fetches).toEqual(['https://slack.com/api/files.info']);
  });

  test('a Kortix workspace that does not hold the Slack workspace downloads nothing and asks Slack nothing, not even whether the file exists', async () => {
    linked = false;
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(fetches).toEqual([]);
  });

  test('a thumbnail URL is confined by the file it belongs to', async () => {
    sharedIn = [];
    sharedPrivately = ['G0EXEC'];
    const thumb = 'https://files.slack.com/files-tmb/T0SYNTH01-F0SYNTH01-9a8b7c/report_360.png';
    const r = await downloadSlackFile('proj-1', thumb, 'user-1', slack);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test('a files.slack.com URL that names no file is refused 400 before any Slack call', async () => {
    for (const url of [
      'https://files.slack.com/files-pri/T0SYNTH01-F0SYNTH01',
      'https://files.slack.com/anything/else',
      'https://files.slack.com/files-pri/T0SYNTH01-F0SYNTH01/a/b/c.pdf',
    ]) {
      const r = await downloadSlackFile('proj-1', url, 'user-1', slack);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(fetches).toEqual([]);
  });
});

describe('downloadSlackFile size limit', () => {
  test('a file whose Content-Length is past the limit is refused 413', async () => {
    body = new Uint8Array(MAX_DOWNLOAD_BYTES + 1);
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  test('a file with no Content-Length stops reading at the limit', async () => {
    body = new Uint8Array(MAX_DOWNLOAD_BYTES + 1);
    lengthHeader = false;
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });
});

// 2026-10-05: 16 file downloads 502'd within 3 h while clean 200s ran between
// the bursts — the files host degraded transiently, and the proxy flattened
// every upstream answer into a bare 502 with no log line, so four root-cause
// sessions had nothing to work from. A download is an idempotent GET: it now
// retries what slackApiCall retries (429 per Retry-After ≤ 5 s, 5xx with the
// same attempt × 400 ms backoff) and answers the upstream truth.
describe('downloadSlackFile transient upstream failures', () => {
  test('a 503 answered once downloads on the retry', async () => {
    fileResponses = [{ status: 503, body: 'Service Unavailable' }, { status: 200, body: new Uint8Array(body) }];
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.byteLength).toBe(8);
    expect(fetches.filter((u) => u === FILE_URL)).toHaveLength(2);
  });

  test('a 429 with a short Retry-After retries and succeeds', async () => {
    fileResponses = [{ status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: new Uint8Array(body) }];
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.byteLength).toBe(8);
    expect(fetches.filter((u) => u === FILE_URL)).toHaveLength(2);
  });

  test('a 429 with a long Retry-After answers 429 without a second fetch', async () => {
    fileResponses = [{ status: 429, body: 'ratelimited', headers: { 'retry-after': '120' } }];
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r).toMatchObject({ ok: false, status: 429 });
    if (!r.ok) expect(r.error).toContain('upstream 429');
    expect(fetches.filter((u) => u === FILE_URL)).toHaveLength(1);
  });

  test('a persistent 503 answers 502 carrying the upstream status and body', async () => {
    fileResponses = [{ status: 503, body: 'Service Unavailable' }];
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (!r.ok) expect(r.error).toContain('upstream 503: Service Unavailable');
    expect(fetches.filter((u) => u === FILE_URL)).toHaveLength(2);
  });

  test('an upstream 403 answers 403, not 502', async () => {
    fileResponses = [{ status: 403, body: 'forbidden' }];
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r).toMatchObject({ ok: false, status: 403 });
    if (!r.ok) expect(r.error).toContain('upstream 403');
  });

  test('a failed fetch retries once and answers 502 instead of throwing', async () => {
    fetchThrows = true;
    const r = await downloadSlackFile('proj-1', FILE_URL, 'user-1', slack);
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (!r.ok) expect(r.error).toContain('unreachable');
    expect(fetches.filter((u) => u === FILE_URL)).toHaveLength(2);
  });
});
