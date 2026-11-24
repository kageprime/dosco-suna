import { CeoHome } from '@/features/marketing/ceo-home/ceo-home';
import { loopViews } from '@/features/marketing/one-prompt/loops-content';
import { marketingMetadataLayout } from '@/lib/seo/metadata';

import { LandingAuthGate } from './landing-auth-gate';

const { generateMetadata } = marketingMetadataLayout('/');

export { generateMetadata };

// The home route is `/[locale]`, so it is the one route a one-segment path such
// as `/security.txt` reaches: the middleware keeps dotted paths off the locale
// rewrite. Every locale is prerendered (the marketing layout's
// `generateStaticParams`), and rendering an unknown one on demand failed with
// "Page changed from static to dynamic at runtime": a 500 on the site
// (KRTX-3255). An unknown value is a 404 without a render, as in
// `solutions/[role]`.
export const dynamicParams = false;

/**
 * The Dosco landing. The roles come from the real starter templates at build
 * time, so the page shows the agents this build actually ships.
 */
export default function Home() {
  const roles = loopViews().map(({ team, line }) => ({ team, line }));
  return (
    <LandingAuthGate>
      <CeoHome roles={roles} />
    </LandingAuthGate>
  );
}
