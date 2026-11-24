import { CeoHome } from '@/features/marketing/ceo-home/ceo-home';
import { catalogViews, loopViews } from '@/features/marketing/one-prompt/loops-content';
import { marketingMetadataLayout } from '@/lib/seo/metadata';

import { LandingAuthGate } from './landing-auth-gate';

const { generateMetadata } = marketingMetadataLayout('/');

export { generateMetadata };

// The home route is `/[locale]`, the one route a one-segment path such as
// `/security.txt` reaches. Every locale is prerendered by this group's layout
// and an unknown one is a 404 without a render (KRTX-3255).
export const dynamicParams = false;

/**
 * The Dosco landing. Roles and catalog come from the shipped starter templates
 * at build time, so the page shows the agents this build actually ships.
 */
export default function Home() {
  return (
    <LandingAuthGate>
      <CeoHome roles={loopViews()} catalog={catalogViews()} />
    </LandingAuthGate>
  );
}
