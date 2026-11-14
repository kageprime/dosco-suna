import { setupTarget, type SetupTarget } from '@kortix/shared/setup-guide';

import { getEnv } from '@/lib/env-config';

/**
 * The deployment this server is (its own web origin and API), so the setup
 * guide it serves points at itself: kortix.com at production, dev.kortix.com
 * at dev, http://localhost:<port> on a local stack. Read per request, so a
 * self-hosted image configured at runtime is right too.
 */
export function serverSetupTarget(): SetupTarget {
  const env = getEnv();
  return setupTarget(env.APP_URL, env.BACKEND_URL);
}
