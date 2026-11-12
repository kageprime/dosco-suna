import { bodyLimit } from 'hono/body-limit';
import { makeOpenApiApp } from '../../openapi';

/**
 * Slack webhook payloads are small (an interactivity or events envelope is a
 * few hundred KiB at most); anything larger is refused unread with a 413
 * before any handler buffers it — and before the signature check, so an
 * anonymous caller chooses neither a big read nor the read time. The limit
 * counts a chunked stream too: whether the body declares its size in
 * Content-Length or streams without one, the read stops at the ceiling.
 */
const MAX_SLACK_WEBHOOK_BODY_BYTES = 1024 * 1024;

export const slackWebhookApp = makeOpenApiApp();
// Mounted before every route — canonical and per-project (BYO), events,
// interactivity and commands alike — so the ceiling holds ahead of `c.req.text()`.
slackWebhookApp.use(
  '/*',
  bodyLimit({
    maxSize: MAX_SLACK_WEBHOOK_BODY_BYTES,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  }),
);

export const FIVE_MINUTES = 5 * 60;

export const EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;

export const WORKING_EMOJI = 'hourglass_flowing_sand';
export const STREAM_TTL_MS = 15 * 60 * 1000;

export const PICKER_TTL_MS = 60 * 60 * 1000;
