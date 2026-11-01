// Expand the aggregate ECS secret before any module reads process.env.
import { loadManagedLineupAtBoot } from './workers/managed-lineup-worker';
import './environment-secret';

// ─── Observability (must follow environment hydration) ───────────────────────
import './lib/sentry';

import { config } from './config';
import { logger } from './lib/logger';
import { describeEmailChain } from './lib/email/transport';
import { primeDaytonaRateLimitClassifier } from './shared/daytona-rate-limit';
import { primeDaytonaTransientClassifier } from './shared/daytona-transient';
import { primeComposioTransientClassifier } from './shared/composio-transient';
import { ensureSchema } from './ensure-schema';
import { bootServices, markSchemaReady, shutdown } from './bootstrap';

void primeDaytonaRateLimitClassifier();
void primeDaytonaTransientClassifier();
void primeComposioTransientClassifier();

logger.info('[worker] Dosco Background Worker starting', {
  env: config.INTERNAL_KORTIX_ENV,
  workers: 'ENABLED',
  database: Boolean(config.DATABASE_URL),
  providers: config.ALLOWED_SANDBOX_PROVIDERS,
});

if (import.meta.main) await loadManagedLineupAtBoot();

logger.info(`[email] ${describeEmailChain()}`);

ensureSchema()
  .then(async () => {
    markSchemaReady();
    await bootServices();
    logger.info('[worker] Background workers initialized successfully');
  })
  .catch(async (err) => {
    logger.error('[worker] ensureSchema failed, starting services anyway', { error: err });
    markSchemaReady();
    await bootServices();
    logger.info('[worker] Background workers initialized');
  });

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
