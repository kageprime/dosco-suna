import { AboutPage as AboutPageContent } from '@/features/marketing/about/about-page';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';

const DESCRIPTION =
  'Dosco Network is where work gets done. A flexible AI agent becomes any role — UI engineer, logo designer, accountant, PR — at 100% capacity, dropping into your sprint to deliver actual work.';

export const metadata: Metadata = {
  title: 'About',
  description: DESCRIPTION,
  keywords:
    'Dosco, Dosco Network, AI agent, deliverables, AI coworker, autonomous work, AI agents',
  openGraph: {
    title: 'About 火 Dosco Network – the AI coworker that delivers',
    description: DESCRIPTION,
    url: `${CANONICAL_ORIGIN}/about`,
    images: [
      {
        url: '/images/team.webp',
        width: 1200,
        height: 675,
        alt: 'The Dosco team',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'About 火 Dosco Network – the AI coworker that delivers',
    description: DESCRIPTION,
    images: ['/images/team.webp'],
  },
  alternates: {
    canonical: `${CANONICAL_ORIGIN}/about`,
  },
};

export default function AboutPage() {
  return <AboutPageContent />;
}
