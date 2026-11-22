import 'server-only';

import { getServerPublicEnv } from '@/lib/public-env-server';
import { runtimeConfigIsBakedAtBuild } from '@/lib/runtime-config-mode';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

/**
 * The launch state of Loopmaxxing. `enabled`: /loopmaxxing and loopmaxxing.sh
 * serve the page. `announced`: the marketing site links to it and search
 * engines may index it. Read at request time, as the root layout reads the
 * runtime config, so one image serves every deployment.
 */
export async function loopmaxxingState(): Promise<{ enabled: boolean; announced: boolean }> {
  if (!runtimeConfigIsBakedAtBuild()) await connection();
  const env = getServerPublicEnv();
  return { enabled: env.LOOPMAXXING_ENABLED, announced: env.LOOPMAXXING_ENABLED && env.LOOPMAXXING_ANNOUNCED };
}

/** 404 for /loopmaxxing until LOOPMAXXING_ENABLED is on (`isLoopmaxxingEnabled`). */
export async function requireLoopmaxxing(): Promise<void> {
  if (!(await loopmaxxingState()).enabled) notFound();
}
