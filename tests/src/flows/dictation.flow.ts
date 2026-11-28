/**
 * DICT-1 — composer dictation. The local profile has no managed upstream, so
 * this flow holds what every deployment shares: who may dictate, the price the
 * server states, and the clip checks answered before any credit or upstream.
 * The served path (a real clip → text → one "Dictation" ledger row) is
 * verified against the dev deployment.
 */
import { flow } from '../core/flow';

const path = '/v1/workspaces/:projectId/dictation';

function form(fields: Record<string, string | Blob>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return body;
}

// A WebM header: enough to pass the type check, never sent upstream here.
const clip = () => new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])], 'clip.webm', { type: 'audio/webm' });

flow(
  'DICT-1',
  {
    domain: 'projects',
    routes: ['GET /v1/workspaces/:projectId/dictation', 'POST /v1/workspaces/:projectId/dictation'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const params = { projectId: project.id };
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('ANON cannot read the dictation price or send a clip', async () => {
      (await ctx.client.as(ctx.P.ANON).get(path, { params })).status(401);
      (await ctx.client.as(ctx.P.ANON).post(path, form({ audio: clip() }), { params })).status(401);
    });

    await ctx.step('a person outside the workspace cannot send a clip', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).post(path, form({ audio: clip() }), { params })).status([403, 404]);
    });

    let available = false;
    await ctx.step('the owner reads the price: 1 credit per minute, 10 minutes and 25 MB per clip', async () => {
      const r = await owner.get(path, { params });
      r.status(200).body().has('$.credits_per_minute', 1).has('$.max_seconds', 600).has('$.max_bytes', 25 * 1024 * 1024);
      available = r.json<{ available: boolean }>().available;
      if (typeof available !== 'boolean') throw new Error(`available is not a boolean: ${r.text()}`);
    });

    await ctx.step('a malformed clip is refused with a code naming the problem, before any credit or upstream', async () => {
      (await owner.post(path, form({ surface: 'web' }), { params })).status(400).body().has('$.code', 'invalid_request');
      (await owner.post(path, form({ audio: new File(['hello'], 'note.txt', { type: 'text/plain' }) }), { params }))
        .status(415)
        .body()
        .has('$.code', 'unsupported_audio');
      (await owner.post(path, form({ audio: new File([], 'empty.webm', { type: 'audio/webm' }) }), { params }))
        .status(400)
        .body()
        .has('$.code', 'empty_audio');
    });

    if (!available) {
      await ctx.step('where no managed provider runs, a valid clip is a 503 dictation_unavailable', async () => {
        (await owner.post(path, form({ audio: clip(), surface: 'web' }), { params }))
          .status(503)
          .body()
          .has('$.code', 'dictation_unavailable');
      });
    }
  },
);
