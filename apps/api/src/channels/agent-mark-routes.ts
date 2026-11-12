import { createRoute, z } from '@hono/zod-openapi';
import { errors, makeOpenApiApp } from '../openapi';
import { agentMarkPng, isAgentMarkSlug } from './core/agent-mark';

/**
 * `GET /v1/agent-marks/:slug.png` — an agent's face as a PNG, public. A chat
 * platform fetches it as the picture beside the agent's messages (Slack's
 * `icon_url`). The picture is a pure function of the slug, so the route reads
 * nothing and reveals nothing beyond the name in its own URL.
 */
export const agentMarkApp = makeOpenApiApp();

export function registerAgentMarkRoutes(): void {
  agentMarkApp.openapi(
    createRoute({
      method: 'get',
      path: '/{file}',
      tags: ['channels'],
      summary: "An agent's face as a PNG",
      request: { params: z.object({ file: z.string().openapi({ example: 'mykortix.png' }) }) },
      responses: {
        200: { description: 'The PNG', content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } } },
        ...errors(404),
      },
    }),
    async (c) => {
      const { file } = c.req.valid('param');
      const slug = file.endsWith('.png') ? file.slice(0, -4) : '';
      if (!isAgentMarkSlug(slug)) return c.json({ error: 'Not found' }, 404);
      const png = await agentMarkPng(slug);
      return c.body(new Uint8Array(png), 200, {
        'Content-Type': 'image/png',
        // The URL carries a version (`agentMarkUrl`), so a new drawing is a new URL.
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    },
  );
}
