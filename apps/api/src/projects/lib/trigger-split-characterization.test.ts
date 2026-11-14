import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  draftToSpec,
  parseTriggerDraft,
  verifyWebhookSignature,
  webhookPayload,
} from './triggers';

describe('trigger split characterization', () => {
  test('webhook HMAC accepts the exact signed timestamp and body and rejects tampering', () => {
    const body = '{"event":"synthetic"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'test-secret').update(`${timestamp}.${body}`).digest('hex');
    expect(verifyWebhookSignature(body, timestamp, 'test-secret', `sha256=${signature}`)).toBe(true);
    // The signature is bound to the timestamp: a replayed body cannot pair it with a newer one.
    expect(verifyWebhookSignature(body, String(Number(timestamp) + 1), 'test-secret', `sha256=${signature}`)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, timestamp, 'test-secret', signature)).toBe(false);
    expect(verifyWebhookSignature(body, timestamp, 'test-secret', 'sha256=bad')).toBe(false);
  });

  test('webhook payload keeps parsed body and selected headers', async () => {
    const app = new Hono();
    app.post('/', (c) => c.json(webhookPayload((name) => c.req.header(name), '{"event":"synthetic"}')));
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'synthetic-agent' },
    });
    expect(await response.json()).toEqual({
      body: { event: 'synthetic' },
      headers: { content_type: 'application/json', user_agent: 'synthetic-agent', forwarded_for: null, github_event: null },
    });
  });

  test('webhook payload names the GitHub event from its header (#12644)', async () => {
    const app = new Hono();
    app.post('/', (c) => c.json(webhookPayload((name) => c.req.header(name), '{"action":"opened"}')));
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
    });
    expect((await response.json()).headers.github_event).toBe('issues');
  });

  const valid = {
    name: 'Synthetic webhook',
    type: 'webhook',
    prompt_template: 'Handle {{ body.event }}',
    secret_env: 'SYNTHETIC_SECRET',
  };

  test('draft parses and converts to the same manifest fields', () => {
    const draft = parseTriggerDraft(valid, { existingSlug: null });
    expect(draft).toMatchObject({
      slug: 'synthetic-webhook', type: 'webhook', agent: 'default', enabled: true,
      sessionMode: 'fresh', secretEnv: 'SYNTHETIC_SECRET',
    });
    if ('error' in draft) throw new Error(draft.error);
    expect(draftToSpec(draft, 'kortix.yaml').path).toBe('kortix.yaml#triggers.synthetic-webhook');
  });

  // An empty prompt is a program agent's payload input; the route refuses it for a model agent
  // once the trigger is in the manifest (extractTriggers knows the agents).
  test('an empty prompt drafts as the payload input, and a static payload rides along', () => {
    const draft = parseTriggerDraft({ ...valid, prompt_template: '', payload: { days: 30 } }, { existingSlug: null });
    if ('error' in draft) throw new Error(draft.error);
    expect(draft.promptTemplate).toBe('');
    expect(draftToSpec(draft, 'kortix.yaml').runPayload).toEqual({ days: 30 });
  });

  test.each([
    [{ name: '' }, 'name is required'],
    [{ slug: 'Invalid slug' }, 'Invalid slug'],
    [{ type: 'other' }, 'type must be'],
    [{ session_mode: 'unknown' }, 'session_mode must be one of'],
    [{ session_mode: 'pinned' }, 'requires a session_id'],
    [{ session_mode: 'keyed' }, 'requires a session_key'],
    [{ filter: [] }, 'filter must map payload paths to a value or one operator'],
    [{ filter: { ' ': 'value' } }, 'filter paths must not be blank'],
    [{ filter: { event: null } }, 'filter.event must be'],
    [{ secret_env: '' }, 'must declare `secret_env`'],
    [{ secret_env: 'lowercase' }, 'secret_env must look like'],
    [{ payload: [1] }, 'payload must be an object'],
  ] as const)('rejects invalid draft field %j', (override, message) => {
    expect(parseTriggerDraft({ ...valid, ...override }, { existingSlug: null })).toMatchObject({
      error: expect.stringContaining(message),
    });
  });
});
