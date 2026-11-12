import { Button } from '@kortix/ui/button';
import type { Metadata } from 'next';

import Link from '@/components/site-link';
import { getTranslations } from '@/i18n/get-translations';
import { ARTIFACT_FRAME_ALLOW, ARTIFACT_IFRAME_SANDBOX } from '@kortix/ui/artifacts';

import { SHARE_FILE_IFRAME_CLASS } from '../../session/[token]/share-layout';
import { ShareChrome, ShareHeader, ShareUnavailable } from '../../share-chrome';

import { loadPublicArtifact } from './public-artifact';

type PublicArtifactRouteProps = {
  params: Promise<{ locale: string; id: string }>;
};

// Anyone with the link, and only them: never in a search index.
const ROBOTS: Metadata['robots'] = { index: false, follow: false };

export async function generateMetadata({ params }: PublicArtifactRouteProps): Promise<Metadata> {
  const { id } = await params;
  const t = await getTranslations('artifacts');
  const result = await loadPublicArtifact(id);
  if (result.kind !== 'shared') return { title: t('notFoundTitle'), robots: ROBOTS };
  const { title, description } = result.artifact;
  return {
    title,
    description: description ?? undefined,
    robots: ROBOTS,
    openGraph: { title, description: description ?? undefined, type: 'article' },
  };
}

/**
 * /share/artifact/[id] — a public artifact: the Kortix bar (symbol, title, one
 * action) above the page. The content server's CSP sandbox isolates the page
 * (see ARTIFACT_IFRAME_SANDBOX); it never runs with this site's origin.
 */
export default async function PublicArtifactPage({ params }: PublicArtifactRouteProps) {
  const { id } = await params;
  const t = await getTranslations('artifacts');
  const result = await loadPublicArtifact(id);

  if (result.kind !== 'shared') {
    return (
      <ShareUnavailable
        title={result.kind === 'busy' ? t('busyTitle') : t('notFoundTitle')}
        description={result.kind === 'busy' ? t('busyHint') : t('notFoundHint')}
        cta={<Link href="/">{t('tryKortix')}</Link>}
      />
    );
  }

  const { artifact } = result;
  return (
    <ShareChrome
      header={
        <ShareHeader
          title={artifact.title}
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/">{t('tryKortix')}</Link>
            </Button>
          }
        />
      }
      sheetClassName="bg-background border-border relative min-h-0 flex-1 overflow-hidden rounded-t-md border-x border-t"
    >
      <iframe
        src={artifact.content_url}
        title={artifact.title}
        className={SHARE_FILE_IFRAME_CLASS}
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        allow={ARTIFACT_FRAME_ALLOW}
        referrerPolicy="no-referrer"
      />
    </ShareChrome>
  );
}
