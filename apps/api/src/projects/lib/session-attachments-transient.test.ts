import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { createClient } from '@supabase/supabase-js';
import { createSessionAttachmentStore } from './session-attachments';

const input = {
  projectId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  attachmentId: '33333333-3333-4333-8333-333333333333',
  filename: 'notes.txt', mime: 'text/plain', bytes: new TextEncoder().encode('saved before wake'),
};
beforeEach(() => { spyOn(Bun, 'sleep').mockResolvedValue(undefined); });
afterEach(() => { mock.restore(); });

function fixture(statuses: number[], existing = 'saved before wake') {
  let uploads = 0;
  let reads = 0;
  const bodies: string[] = [];
  const client = createClient('http://storage.example.test', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === 'POST') {
        uploads++;
        bodies.push(await new Response(init.body).text());
        const status = statuses.shift() ?? 500;
        if (status === 502) return new Response('Bad Gateway', { status, statusText: 'Bad Gateway' });
        return Response.json(status === 200 ? { Key: 'object' } : { statusCode: String(status), message: status === 409 ? 'already exists' : 'refused' }, { status });
      }
      reads++;
      return new Response(existing, { headers: { 'Content-Type': 'text/plain' } });
    }, { preconnect: fetch.preconnect }) },
  });
  return { store: createSessionAttachmentStore(client.storage), bodies, counts: () => ({ uploads, reads }) };
}

test('a gateway failure retries the same immutable upload once', async () => {
  const f = fixture([502, 200]);
  expect((await f.store.put(input)).url).toContain(input.attachmentId);
  expect(f.counts()).toEqual({ uploads: 2, reads: 0 });
  expect(f.bodies).toEqual(['saved before wake', 'saved before wake']);
});

test('an ambiguous gateway failure accepts a verified duplicate after retry', async () => {
  const f = fixture([502, 409]);
  await f.store.put(input);
  expect(f.counts()).toEqual({ uploads: 2, reads: 1 });
});

test('a retry cannot replace different bytes', async () => {
  const f = fixture([502, 409], 'different content');
  await expect(f.store.put(input)).rejects.toThrow('different file');
});

test.each([502, 503, 504])('persistent %s is bounded to two attempts', async (status) => {
  const f = fixture([status, status, 200]);
  await expect(f.store.put(input)).rejects.toMatchObject({ status });
  expect(f.counts()).toEqual({ uploads: 2, reads: 0 });
});

test.each([400, 401, 403, 404, 500])('HTTP %s is not retried', async (status) => {
  const f = fixture([status, 200]);
  await expect(f.store.put(input)).rejects.toMatchObject({ status });
  expect(f.counts()).toEqual({ uploads: 1, reads: 0 });
});
