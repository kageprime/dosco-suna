import { getWeeklyChangelog } from '@/features/marketing/changelog/releases';
import { getServerPublicEnv } from '@/lib/public-env-server';
import type { WhatsNew } from '@/features/layout/help-menu/whats-new';

/**
 * The newest changelog weeks for the help menu's "What's new" list.
 *
 * Dynamic so a self-host's runtime env wins over the build: with the landing
 * page disabled, `/changelog` bounces to the app, so the list is off.
 * `getWeeklyChangelog` is already cached for an hour (`unstable_cache`), so a
 * request costs no GitHub call. A GitHub outage answers 503, and the menu
 * still links the full changelog.
 */
export const dynamic = 'force-dynamic';

const WEEK_COUNT = 3;

export async function GET() {
  const enabled = !getServerPublicEnv().DISABLE_LANDING_PAGE;
  const body: WhatsNew = { enabled, weeks: [] };
  if (enabled) {
    // `getWeeklyChangelog` rethrows a GitHub failure on a deployment that
    // bakes its config at build. The menu then lists no weeks.
    const weeks = await getWeeklyChangelog().then(
      (changelog) => changelog.weeks,
      () => [],
    );
    body.weeks = weeks.slice(0, WEEK_COUNT).map((week) => ({
      slug: week.slug,
      title: week.headline,
      date: week.start,
      href: `/changelog/${week.slug}`,
    }));
  }
  // No weeks from an enabled changelog is a failed read: answer 503, never
  // cached, so the client keeps no empty list and reads again next mount.
  if (enabled && body.weeks.length === 0) {
    return Response.json(body, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(body, {
    headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600' },
  });
}
