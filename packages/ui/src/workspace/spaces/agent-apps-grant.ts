import type { AgentGrantSet } from '@kortix/sdk';

/**
 * The grant after one switch. Turning one off under `all` lists every other
 * connector; turning one on adds it. A grant that lists every connector stays
 * a list, so a connector added later is not granted by surprise.
 */
export function toggleGrant(grant: AgentGrantSet, slugs: readonly string[], slug: string, on: boolean): AgentGrantSet {
  const base = grant === 'all' ? [...slugs] : grant;
  if (on) return base.includes(slug) ? base : [...base, slug];
  return base.filter((item) => item !== slug);
}
