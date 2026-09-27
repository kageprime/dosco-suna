import { AboutPage as AboutPageContent } from '@/features/marketing/about/about-page';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';

const DESCRIPTION =
  'Dosco Network is where work gets done. A flexible AI agent becomes any role — UI engineer, logo designer, accountant, PR — at 100% capacity, dropping into your sprint to deliver actual work.';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  const title = t.raw('text4efca0d10c5f');
  const socialTitle = t.raw('text18f31a325716');
  const description = t.raw('text445cf0a2abfa');
  return {
    title,
    description,
    keywords:
      'Dosco, about Dosco, open AGI platform, open source AI management system, autonomous companies, AI agents, self-hosted agent platform',
    openGraph: {
      title: socialTitle,
      description,
      url: `${CANONICAL_ORIGIN}/about`,
      images: [
        {
          url: '/images/team.webp',
          width: 1200,
          height: 675,
          alt: t.raw('text49e7ba9f095d'),
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: ['/images/team.webp'],
    },
    alternates: {
      canonical: `${CANONICAL_ORIGIN}/about`,
    },
  };
}

export default function AboutPage() {
  return <AboutPageContent />;
}
