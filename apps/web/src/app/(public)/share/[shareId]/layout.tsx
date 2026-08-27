import { getServerPublicEnv } from '@/lib/public-env-server';
import { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;

  const title = 'Shared Conversation | Dosco';
  const description = 'Replay this Worker conversation on Dosco';
  const url = getServerPublicEnv().APP_URL || 'https://dosco.example.com';

  return {
    title,
    description,
    alternates: {
      canonical: `${url}/share/${shareId}`,
    },
    openGraph: {
      title,
      description,
      images: [`${url}/share-page/og-fallback.png`],
    },
    twitter: {
      title,
      description,
      images: `${url}/share-page/og-fallback.png`,
      card: 'summary_large_image',
    },
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
