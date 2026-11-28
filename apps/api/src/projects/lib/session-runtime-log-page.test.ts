import { describe, expect, test } from 'bun:test';
import { jsonStructureExceeds, readRuntimeLogPageBody, RUNTIME_LOG_PAGE_MAX_BYTES, RUNTIME_LOG_PAGE_MAX_TOKENS } from './session-runtime-transport';

/** A response whose body streams `bytes` bytes of JSON-ish text in 64 kB chunks, counting what was read. */
function streamed(bytes: number, headers: Record<string, string> = {}) {
  let read = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (read >= bytes) return controller.close();
      const next = chunk.subarray(0, Math.min(chunk.byteLength, bytes - read));
      read += next.byteLength;
      controller.enqueue(next);
    },
  });
  return { response: new Response(body, { headers }), read: () => read };
}

describe('readRuntimeLogPageBody: the box answer of GET …/log?live=1, read with a byte ceiling', () => {
  test('a JSON page under the ceiling is parsed', async () => {
    const page = { generation: 0, thread_id: 'ses_root', messages: [], has_more: false };
    expect(await readRuntimeLogPageBody(Response.json(page))).toEqual({ ok: true, body: page });
  });

  test('a body over the ceiling is refused, and reading stops at the ceiling', async () => {
    const { response, read } = streamed(RUNTIME_LOG_PAGE_MAX_BYTES * 4);
    expect(await readRuntimeLogPageBody(response)).toEqual({ ok: false, reason: 'too_large', status: 200 });
    // The stream pulls ahead by its queue (a chunk or two), never to the end of the 32 MiB body.
    expect(read()).toBeLessThan(RUNTIME_LOG_PAGE_MAX_BYTES + 4 * 64 * 1024);
  });

  test('a Content-Length over the ceiling is refused before the body is read', async () => {
    const { response, read } = streamed(1024, { 'content-length': String(RUNTIME_LOG_PAGE_MAX_BYTES + 1) });
    expect(await readRuntimeLogPageBody(response)).toEqual({ ok: false, reason: 'too_large', status: 200 });
    expect(read()).toBe(0);
  });

  test('the ceilings: 2 MiB, the stored page budget, and 50,000 structural tokens (real pages: at most 430 kB and 2,436 tokens)', () => {
    expect(RUNTIME_LOG_PAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(RUNTIME_LOG_PAGE_MAX_TOKENS).toBe(50_000);
  });

  test('a body under the byte ceiling made of many small values is refused before it is parsed', async () => {
    const tiny = `[${Array.from({ length: 200_000 }, () => '[]').join(',')}]`;
    expect(tiny.length).toBeLessThan(RUNTIME_LOG_PAGE_MAX_BYTES);
    expect(await readRuntimeLogPageBody(new Response(tiny))).toEqual({ ok: false, reason: 'too_complex', status: 200 });
  });

  test('structure inside strings does not count: a page of long texts full of brackets and commas is read', async () => {
    const text = '[{,}],'.repeat(100_000);
    const page = { generation: 0, thread_id: 'ses_root', messages: [{ blocks: [{ type: 'text', text: `say "${text}"` }] }], has_more: false };
    expect((await readRuntimeLogPageBody(Response.json(page))).ok).toBe(true);
    expect(jsonStructureExceeds(new TextEncoder().encode(JSON.stringify(page)), 10)).toBe(false);
  });

  test('a body that is not JSON is refused', async () => {
    expect(await readRuntimeLogPageBody(new Response('<html>'))).toEqual({ ok: false, reason: 'invalid_json', status: 200 });
  });
});
