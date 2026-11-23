import { FactoryHome } from '@/features/marketing/one-prompt/factory-home';
import { catalogViews, loopViews } from '@/features/marketing/one-prompt/loops-content';

/**
 * Loopmaxxing, the developer landing: one prompt adds loops to your repo.
 * loopmaxxing.sh serves it at its root (the middleware rewrites that host);
 * every deployment also serves it at /loopmaxxing. The featured loops and the
 * catalog are read from the template files at build time, so the page shows
 * what this build really ships.
 */
export default function Loopmaxxing() {
  // The launch leads with one template. The other factories are in the build; they join the page when their reference repositories are public.
  const loops = loopViews().filter((loop) => loop.id === 'software-factory');
  return <FactoryHome loops={loops} catalog={['Marketing', 'Sales', 'Support', 'Recruiting', ...catalogViews()]} />;
}
