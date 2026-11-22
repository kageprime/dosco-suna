import { FactoryHome } from '@/features/marketing/one-prompt/factory-home';
import { loopViews } from '@/features/marketing/one-prompt/loops-content';
import { loopmaxxingJsonLd } from '@/features/marketing/one-prompt/seo';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { requireLoopmaxxing } from '@/lib/loopmaxxing-gate';

/**
 * Loopmaxxing, the developer landing: one prompt adds loops to your repo.
 * loopmaxxing.sh serves it at its root (the middleware rewrites that host);
 * every deployment also serves it at /loopmaxxing. The featured loops and the
 * catalog are read from the template files at build time, so the page shows
 * what this build really ships.
 */
export default async function Loopmaxxing() {
  // The layout gates too; the page renders beside it, so it must not send its content while the page is off.
  await requireLoopmaxxing();
  // The launch leads with one template. The other factories are in the build; they join the page when their reference repositories are public.
  const loops = loopViews().filter((loop) => loop.id === 'software-factory');
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonForHtml(loopmaxxingJsonLd()) }} />
      <FactoryHome loops={loops} />
    </>
  );
}
