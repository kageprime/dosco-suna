/**
 * The Kortix API base every server route forwards to. One documented
 * variable, `KORTIX_UPSTREAM`, the same name the Convex deployment reads.
 * Routes that each read their own variable drifted apart and 404'd before.
 */
export function upstreamBase(): string {
  return (process.env.KORTIX_UPSTREAM ?? 'https://api.kortix.com/v1').replace(/\/+$/, '');
}
