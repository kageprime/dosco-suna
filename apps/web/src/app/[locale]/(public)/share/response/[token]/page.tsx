import { Button } from '@kortix/ui/button';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import Link from '@/components/site-link';
import { getTranslations } from '@/i18n/get-translations';

import { ShareChrome, ShareHeader, ShareUnavailable } from '../../share-chrome';

import { loadPublicResponse, plainTextExcerpt } from './public-response';
import { ResponseMarkdown, SharedPrompt } from './response-markdown';

type PublicResponseRouteProps = {
  params: Promise<{ locale: string; token: string }>;
};

// A shared response is reachable by anyone with the token, and only by them:
// it must never enter a search index.
const ROBOTS: Metadata['robots'] = { index: false, follow: false };

export async function generateMetadata({ params }: PublicResponseRouteProps): Promise<Metadata> {
  const { token } = await params;
  const t = await getTranslations('turnShare');
  const result = await loadPublicResponse(token);
  if (result.kind !== 'shared') {
    return {
      title:
        result.kind === 'revoked'
          ? t('goneTitle')
          : result.kind === 'busy'
            ? t('busyTitle')
            : t('fallbackTitle'),
      robots: ROBOTS,
    };
  }
  const title = result.response.title || t('fallbackTitle');
  const description = plainTextExcerpt(result.response.markdown);
  return {
    title,
    description,
    robots: ROBOTS,
    openGraph: { title, description, type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function PublicResponsePage({ params }: PublicResponseRouteProps) {
  const { locale, token } = await params;
  const t = await getTranslations('turnShare');
  const result = await loadPublicResponse(token);
  if (result.kind === 'missing') notFound();

  // Revoked or busy: the quiet auth frame, the same one an unavailable session
  // share shows (ShareUnavailable).
  if (result.kind === 'revoked' || result.kind === 'busy') {
    const revoked = result.kind === 'revoked';
    return (
      <ShareUnavailable
        title={revoked ? t('goneTitle') : t('busyTitle')}
        description={revoked ? t('goneHint') : t('busyHint')}
        cta={<Link href="/">{t('tryKortix')}</Link>}
      />
    );
  }

  const { response } = result;
  const title = response.title || t('fallbackTitle');
  // The date only: an agent name can be internal, so the page never shows it.
  const respondedAt = new Date(response.responded_at);
  const respondedOn = Number.isNaN(respondedAt.getTime())
    ? null
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(respondedAt);

  // Same chrome as the session share page: a bg-card canvas, the h-12 bar
  // (symbol + title left, one secondary action right), and a rounded
  // bg-background sheet below. The sheet scrolls; the bar stays.
  return (
    <ShareChrome
      header={
        <ShareHeader
          title={title}
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/">{t('tryKortix')}</Link>
            </Button>
          }
        />
      }
      sheetClassName="bg-background border-border relative min-h-0 flex-1 overflow-y-auto rounded-t-md border-x border-t"
    >
      <article className="mx-auto w-full max-w-3xl px-6 py-10">
        {respondedOn ? <p className="text-muted-foreground mb-6 text-xs">{respondedOn}</p> : null}
        {response.prompt ? (
          <div className="mb-6">
            <SharedPrompt text={response.prompt} />
          </div>
        ) : null}
        <ResponseMarkdown markdown={response.markdown} />
      </article>
    </ShareChrome>
  );
}
