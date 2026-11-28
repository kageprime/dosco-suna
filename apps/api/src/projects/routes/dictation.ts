import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { DICTATION_CREDITS_PER_MINUTE } from '../../billing/services/tiers';
import { createDictationRateLimitMiddleware } from '../../middleware/rate-limit';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { capturePersonEvent } from './product-events';
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_SECONDS,
  dictationAvailable,
  transcribeDictation,
} from '../dictation/transcribe';

const path = '/{workspaceId}/dictation';
const params = z.object({ workspaceId: z.string().uuid() });
const SURFACES = ['web', 'desktop', 'mobile', 'other'] as const;

const infoSchema = z.object({
  available: z.boolean().openapi({ description: 'False on a server that serves no managed models (a self-host without Platinum).' }),
  credits_per_minute: z.number().openapi({ description: 'The price: credits per minute of audio, billed per second. 1 credit = $0.01.' }),
  max_seconds: z.number().int().openapi({ description: 'The longest clip a composer records.' }),
  max_bytes: z.number().int(),
});

const resultSchema = z.object({
  text: z.string().openapi({ description: 'The words heard, trimmed. Empty when the clip held no speech.' }),
  seconds: z.number().openapi({ description: 'The billed audio duration.' }),
  credits: z.number().openapi({ description: 'Credits charged for this clip (1 credit = $0.01).' }),
});

export function registerDictationRoutes(): void {
  projectsApp.use(
    '/:workspaceId/dictation',
    bodyLimit({
      maxSize: DICTATION_MAX_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: 'The recording is larger than 25 MB.', code: 'audio_too_large' }, 413),
    }),
  );
  projectsApp.use('/:workspaceId/dictation', createDictationRateLimitMiddleware());

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path,
      tags: ['dictation'],
      summary: 'Read whether dictation is available and what it costs',
      ...auth,
      request: { params },
      responses: { 200: json(infoSchema, 'Dictation availability and price'), ...errors(401, 403, 404) },
    }),
    async (c) => {
      const { workspaceId: projectId } = c.req.valid('param');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      return c.json(
        {
          available: dictationAvailable(),
          credits_per_minute: DICTATION_CREDITS_PER_MINUTE,
          max_seconds: DICTATION_MAX_SECONDS,
          max_bytes: DICTATION_MAX_BYTES,
        },
        200,
      );
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path,
      tags: ['dictation'],
      summary: 'Transcribe a dictated clip into text',
      description:
        'Speech-to-text for the composer. Send one recorded clip (WebM, Ogg, MP4/M4A, MP3, WAV or FLAC, up to 25 MB); the answer is its text. ' +
        'Charged from the workspace credits at `credits_per_minute` (GET this path), billed per second, on every plan, whether or not the clip holds speech. ' +
        'Neither the audio nor the text is stored. Needs permission to start sessions in the project. ' +
        '`402` codes: `insufficient_credits` (with `billing_state`), `budget_exceeded`. `503` codes: `dictation_unavailable`, `dictation_busy`, `dictation_failed`.',
      ...auth,
      request: {
        params,
        body: {
          required: true,
          content: {
            'multipart/form-data': {
              // Both optional here: the handler answers a missing clip with its
              // own code, and an unknown surface counts as `other`.
              schema: z.object({
                audio: z.any().optional().openapi({ type: 'string', format: 'binary', description: 'The recorded clip (required).' }),
                surface: z.string().optional().openapi({ description: 'The client that recorded it, for product analytics: web, desktop, mobile or other.' }),
              }),
            },
          },
        },
      },
      responses: {
        200: json(resultSchema, 'The transcript'),
        ...errors(400, 401, 402, 403, 404, 413, 415, 429, 503),
      },
    }),
    async (c) => {
      const { workspaceId: projectId } = c.req.valid('param');
      const loaded = await loadProjectForUser(c, projectId, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_START);

      // After the validator read the body, Hono hands back the cached form
      // (not always a promise): await it inside try, never chain `.catch`.
      let form: FormData | null = null;
      try {
        form = await c.req.formData();
      } catch {
        form = null;
      }
      const audio = form?.get('audio');
      if (!(audio instanceof Blob)) {
        return c.json({ error: 'Send the recording as the `audio` field of a multipart form.', code: 'invalid_request' }, 400);
      }
      const rawSurface = form?.get('surface');
      const surface = SURFACES.find((s) => s === rawSurface) ?? 'other';

      const result = await transcribeDictation(
        { accountId: loaded.row.accountId, projectId, userId: loaded.userId },
        audio,
        c.req.raw.signal,
      );
      c.header('Cache-Control', 'no-store');
      if (!result.ok) {
        if (result.status === 402) {
          capturePersonEvent(c, loaded, projectId, 'billing_gate_hit', { reason: result.code, where: 'dictation' });
        }
        if (result.retryAfterSeconds) c.header('Retry-After', String(result.retryAfterSeconds));
        return c.json(
          {
            error: result.message,
            message: result.message,
            code: result.code,
            ...(result.billing
              ? {
                  balance: result.billing.balance,
                  has_subscription: result.billing.hasSubscription,
                  billing_state: result.billing.billingState,
                  account_id: loaded.row.accountId,
                }
              : {}),
          },
          result.status,
        );
      }
      capturePersonEvent(c, loaded, projectId, 'dictation_transcribed', {
        seconds: result.seconds,
        latency_ms: result.latencyMs,
        bytes: audio.size,
        surface,
        heard: result.text.length > 0,
      });
      return c.json(
        { text: result.text, seconds: result.seconds, credits: Number((result.costUsd * 100).toFixed(4)) },
        200,
      );
    },
  );
}
