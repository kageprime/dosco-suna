import type { SandboxProvider, SandboxStatus } from './contract';

/**
 * Remove one provider box and prove it is gone. A remove that fails because the
 * box is already gone (Platinum 404s an already-deleted sandbox) counts as
 * removed: the provider is asked for its status and only `removed` counts.
 * `error` is the remove failure, left to the caller's own logging and escalation.
 *
 * Its own module, not `index.ts`: many suites replace the registry module with
 * a `getProvider`-only mock, which would strip this export from every importer.
 */
export async function removeProviderBox(
  provider: Pick<SandboxProvider, 'remove' | 'getStatus'>,
  externalId: string,
): Promise<{ removed: boolean; status: SandboxStatus; error?: unknown }> {
  try {
    await provider.remove(externalId);
    return { removed: true, status: 'removed' };
  } catch (error) {
    const status = await provider.getStatus(externalId).catch(() => 'unknown' as const);
    return { removed: status === 'removed', status, error };
  }
}
