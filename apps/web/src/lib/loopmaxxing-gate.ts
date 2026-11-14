import 'server-only';

import { getServerPublicEnv } from '@/lib/public-env-server';
import { runtimeConfigIsBakedAtBuild } from '@/lib/runtime-config-mode';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

/**
 * 404 for /loopmaxxing until LOOPMAXXING_ENABLED is on
 * (`isLoopmaxxingEnabled`). Read at request time, as the root layout reads
 * the runtime config, so one image serves dev with the page and prod without.
 */
export async function requireLoopmaxxing(): Promise<void> {
  if (!runtimeConfigIsBakedAtBuild()) await connection();
  if (!getServerPublicEnv().LOOPMAXXING_ENABLED) notFound();
}
