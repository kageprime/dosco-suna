import { afterEach, describe, expect, test } from 'bun:test';
import { postBlocks, postMessage, startStream } from '../channels/slack-api';
import { slackPersonaFor } from '../channels/slack/persona';

/**
 * Every message a Dosco agent writes in Slack carries that agent's name as
 * its author (`username`, `chat:write.customize`), so a thread shows which
 * agent answered instead of "Dosco" for all of them. Dosco's own notices
 * carry none.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function slack(answer: (call: Call, index: number) => unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split('/').pop() ?? '';
    const raw = String(init?.body ?? '');
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, body });
    return new Response(JSON.stringify(answer(calls.at(-1)!, calls.length - 1)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return calls;
}

const persona = { username: 'Research', icon_url: 'https://api.example.com/v1/agent-marks/research.png?v=1' };

describe('Slack agent persona', () => {
  test('the agent name is the author of a post, a block post and a stream', async () => {
    const calls = slack(() => ({ ok: true, ts: '1.1' }));
    await postMessage('xoxb-test', 'C1', 'hi', '1.0', persona);
    await postBlocks('xoxb-test', 'C1', 'hi', [], '1.0', persona);
    await startStream('xoxb-test', 'C1', '1.0', 'U1', 'T1', [], persona);
    expect(calls.map((c) => [c.method, c.body.username, c.body.icon_url])).toEqual([
      ['chat.postMessage', 'Research', persona.icon_url],
      ['chat.postMessage', 'Research', persona.icon_url],
      ['chat.startStream', 'Research', persona.icon_url],
    ]);
  });

  test('without chat:write.customize the post is sent once more as Dosco, not lost', async () => {
    const calls = slack((_call, i) => (i === 0 ? { ok: false, error: 'missing_scope' } : { ok: true, ts: '1.2' }));
    expect(await postMessage('xoxb-test', 'C1', 'hi', '1.0', persona)).toBe('1.2');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.username).toBe('Research');
    expect(calls[1]?.body.username).toBeUndefined();
    expect(calls[1]?.body.icon_url).toBeUndefined();
  });

  test('any other refusal is not retried', async () => {
    const calls = slack(() => ({ ok: false, error: 'channel_not_found' }));
    expect(await postMessage('xoxb-test', 'C1', 'hi', '1.0', persona)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("Dosco's own notice carries no author", async () => {
    const calls = slack(() => ({ ok: true, ts: '1.3' }));
    await postMessage('xoxb-test', 'C1', 'hi', '1.0');
    expect(calls[0]?.body.username).toBeUndefined();
  });

  test('a persona is the agent display name, as the web app shows it; none for a blank one', () => {
    expect(slackPersonaFor(' research ')?.username).toBe('Research');
    expect(slackPersonaFor('mykortix')?.username).toBe('My Kortix');
    expect(slackPersonaFor('session-reviewer')?.username).toBe('Session reviewer');
    expect(slackPersonaFor('')).toBeNull();
    expect(slackPersonaFor(null)).toBeNull();
    expect(slackPersonaFor('a'.repeat(100))?.username).toHaveLength(80);
  });
});
