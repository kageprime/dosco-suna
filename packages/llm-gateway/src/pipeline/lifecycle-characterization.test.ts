import { describe, expect, test } from 'bun:test';
import { createGateway } from '../create-gateway';
import type { GatewayHooks, UsageEvent } from '../domain';
import { applyImageWindow } from './image-window';
import { estimatePromptTokens } from '../usage/estimate';

const principal = { userId: 'synthetic-user', accountId: 'synthetic-account' };
const descriptor = { provider: 'synthetic', kind: 'openai-compat' as const, baseUrl: 'https://synthetic.example/v1', apiKey: 'synthetic', billingMode: 'credits' as const, markup: 1, pricing: { inputPerMillion: 1, outputPerMillion: 2 } };
const logger = { info() {}, warn() {}, error() {} };
function hooks(events: UsageEvent[] = []): GatewayHooks {
  return {
    authenticate: async () => principal,
    resolveUpstream: async () => [descriptor],
    assertBillingActive: async () => {},
    recordUsage: async (event) => { events.push(event); },
  };
}
const request = () => ({ authorization: 'Bearer synthetic', rawBody: JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'user', content: 'hello' }] }) });

describe('chat lifecycle characterization through createGateway', () => {
  for (const phase of ['admission', 'route', 'billing', 'dispatch'] as const) {
    test(`${phase} retains its error envelope`, async () => {
      const configured = hooks();
      if (phase === 'admission') configured.authorize = async () => { throw new Error('offline'); };
      if (phase === 'route') configured.resolveRoute = async () => { throw new Error('offline'); };
      if (phase === 'billing') configured.assertBillingActive = async () => { throw Object.assign(new Error('inactive'), { reason: 'subscription_required' }); };
      const gateway = createGateway(configured, { logger, fetchImpl: async () => { throw new Error('offline'); } });
      const response = await gateway.chatCompletions(request());
      const expected = {
        admission: [503, 'admission_unavailable', '', ''],
        route: [502, 'routing_unavailable', 'synthetic-model', 'synthetic-model'],
        billing: [402, 'subscription_required', 'synthetic-model', 'synthetic-model'],
        dispatch: [502, 'upstream_error', 'synthetic-model', 'synthetic-model'],
      } as const;
      const selected = expected[phase];
      expect(response.status).toBe(selected[0]);
      expect(await response.json()).toMatchObject({ error: { code: selected[1], requested_model: selected[2], resolved_model: selected[3] } });
    });
  }

  test('a non-stream answer without usage settles the prompt and output estimate once', async () => {
    const events: UsageEvent[] = [];
    const gateway = createGateway(hooks(events), { logger, fetchImpl: async () => Response.json({ choices: [{ message: { content: 'eight888' } }] }) });
    const input = request();
    const promptTokens = estimatePromptTokens(JSON.parse(input.rawBody));
    const response = await gateway.chatCompletions(input);
    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ promptTokens, completionTokens: 2, usageEstimated: true, model: 'synthetic-model' });
  });

  test('images route and prune, while audio and files only affect the billing estimate', async () => {
    for (const type of ['image', 'image_url', 'input_image', 'file', 'input_audio', 'file_data']) {
      const image = ['image', 'image_url', 'input_image'].includes(type);
      const parts = [{ type, data: 'synthetic' }, { type, data: 'synthetic' }];
      const body = { model: 'synthetic-model', messages: [{ role: 'user', content: parts }] };
      const estimated = estimatePromptTokens(body);
      expect(estimated).toBe(2004);
      const pruned = structuredClone(body);
      expect(applyImageWindow(pruned, { maxImages: 1, keepOnOverflow: 0 }).dropped).toBe(image ? 1 : 0);
      const requires: boolean[] = [];
      const gateway = createGateway({ ...hooks(), resolveRoute: async (_principal, input) => { requires.push(input.requires?.imageInput ?? false); return null; } }, {
        logger, imageWindow: { maxImages: 0, keepOnOverflow: 0 }, fetchImpl: async () => Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }),
      });
      const response = await gateway.chatCompletions({ authorization: 'Bearer synthetic', rawBody: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(requires).toEqual([image]);
    }
  });
});
