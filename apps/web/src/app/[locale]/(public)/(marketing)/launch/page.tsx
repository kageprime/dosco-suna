import { LaunchPage } from '@/features/marketing/launch/launch-page';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dosco — the agentic operating system',
  description:
    'Your agents, skills, company memory and connectors in one managed workspace. Any model, your keys.',
  // Link-shared until the launch is announced; then add it to lib/seo/public-content.ts.
  robots: { index: false, follow: false },
};

export default function Page() {
  return <LaunchPage />;
}
