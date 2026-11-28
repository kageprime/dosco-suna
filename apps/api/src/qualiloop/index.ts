/**
 * `POST /v1/qualiloop/chat`: the endpoint QualiLoop tests the Kortix agent
 * through (QualiLoop's connect contract: `{prompt, metadata.session_id}` in,
 * `{reply}` out). Off (404) unless `QUALILOOP_AGENT_SECRET` and
 * `QUALILOOP_KORTIX_PROJECT_ID` are set; QualiLoop proves itself with the
 * secret in `X-Agent-Secret`.
 *
 * A turn can run for minutes (a sandbox boot, tool calls) and Cloudflare cuts a
 * response whose first byte takes over 100 s. The route answers 200 at once
 * and sends a space every 15 s until the JSON follows: leading whitespace is
 * valid JSON. A failed turn ends the body as `{"error": ...}`, with no `reply`.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { config } from '../config';
import { logger } from '../lib/logger';
import { makeOpenApiApp } from '../openapi';
import { QualiloopTurnError, runQualiloopTurn } from '../projects/surface';

export const qualiloopApp = makeOpenApiApp();

const KEEPALIVE_MS = 15_000;

const ChatBody = z.object({
  prompt: z.string().min(1).max(100_000),
  metadata: z.object({
    session_id: z.string().min(1).max(200),
    turn_index: z.number().int().min(0).optional(),
  }).passthrough(),
});

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerQualiloopRoutes(): void {
  // Documented only, never validated by the router: the handler must check the secret (401) before it parses
  // the body (400), so an unauthenticated caller learns nothing about the request shape.
  qualiloopApp.openAPIRegistry.registerPath({
    method: 'post',
    path: '/chat',
    tags: ['qualiloop'],
    summary: 'Run an external agent evaluation turn',
    description:
      'QualiLoop protocol endpoint. Requires X-Agent-Secret and a configured evaluation project. Leading JSON whitespace keeps the response alive until the turn completes.',
    security: [],
    request: {
      headers: z.object({ 'x-agent-secret': z.string() }),
      body: { required: true, content: { 'application/json': { schema: ChatBody } } },
    },
    responses: {
      200: {
        description: 'Whitespace-prefixed JSON containing reply, or error if the turn fails',
        content: { 'application/json': { schema: z.union([z.object({ reply: z.string() }), z.object({ error: z.string() })]) } },
      },
      400: { description: 'Invalid conversation request' },
      401: { description: 'Invalid evaluation secret' },
      404: { description: 'Evaluation endpoint is disabled' },
    },
  });
  qualiloopApp.post('/chat', async (c) => {
    const secret = config.QUALILOOP_AGENT_SECRET;
    if (!secret || !config.QUALILOOP_KORTIX_PROJECT_ID) return c.json({ error: 'Not found' }, 404);
    if (!secretMatches(c.req.header('x-agent-secret') ?? '', secret)) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Expected {prompt, metadata: {session_id}}' }, 400);
    const { prompt, metadata } = parsed.data;

    // The turn runs outside the stream: Bun sends nothing a stream enqueues
    // while its async `start()` is still pending (measured through Cloudflare:
    // the 15 s spaces arrived with the reply, and a 100 s+ turn got a 524).
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const send = (text: string) => {
      if (open) controller.enqueue(encoder.encode(text));
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        open = false; // QualiLoop hung up: the turn finishes, nothing more is sent.
      },
    });
    send(' ');
    const keepalive = setInterval(() => send(' '), KEEPALIVE_MS);
    void runQualiloopTurn({ conversationId: metadata.session_id, turnIndex: metadata.turn_index ?? 0, prompt })
      .then((reply) => ({ reply }))
      .catch((error: unknown) => {
        if (!(error instanceof QualiloopTurnError)) logger.error('[qualiloop] turn failed', { error: String(error) });
        return { error: error instanceof QualiloopTurnError ? error.message : 'The turn failed inside Kortix.' };
      })
      .then((result) => {
        clearInterval(keepalive);
        send(JSON.stringify(result));
        if (open) controller.close();
      });
    // `no-transform` keeps the compression middleware from holding the body (its 1 KB peek would wait for
    // the answer). Set through c.header, not on a new Response: behind the edge the rate-limit middleware
    // sets `Cache-Control: no-store` first, and Hono copies it over the headers of a Response a route builds.
    c.header('Content-Type', 'application/json');
    c.header('Cache-Control', 'no-store, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return c.body(body, 200);
  });
}
