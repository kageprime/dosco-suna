import { describe, expect, test } from 'bun:test';
import { app } from '../index';

describe('POST /v1/qualiloop/chat in the published spec', () => {
  test('documents the required JSON body and the secret header', async () => {
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: { required?: boolean; content: Record<string, { schema: { required?: string[] } }> }; parameters?: Array<{ in: string; name: string }> }>>;
    };
    const op = doc.paths['/v1/qualiloop/chat']?.post;
    expect(op?.requestBody?.required).toBe(true);
    expect(op?.requestBody?.content['application/json']?.schema.required).toEqual(['prompt', 'metadata']);
    expect(op?.parameters?.some((p) => p.in === 'header' && p.name === 'x-agent-secret')).toBe(true);
  });

  test('the router does not validate the body: a disabled endpoint answers 404, not 400', async () => {
    const res = await app.request('/v1/qualiloop/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
    expect(res.status).toBe(404);
  });
});
