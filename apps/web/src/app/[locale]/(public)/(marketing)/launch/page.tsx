import { LaunchPage } from '@/features/marketing/launch/launch-page';
import type { Metadata } from 'next';

export const metadata: Metadata = {
<<<<<<< HEAD
  title: 'Dosco — the open-source AI Management System',
=======
  title: 'Kortix — the open-source AI Operating System',
>>>>>>> upstream-dev
  description:
    'Your agents, skills, company memory and connectors in one git repo you own. Any model, your keys, self-hosted or managed cloud.',
  // Link-shared until the launch is announced; then add it to lib/seo/public-content.ts.
  robots: { index: false, follow: false },
};

export default function Page() {
  return <LaunchPage />;
}
