import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';

import { getLocale, getMessages, getTranslations } from '@/i18n/get-translations';
import { siteMetadata } from '@kortix/ui/internal/lib/site-metadata';

import NotFoundBoundary from './[locale]/not-found';
import { notFoundMessages } from './not-found-messages';
import './globals.css';

/**
 * The 404 page for URLs that match no route at all — site areas the
 * middleware passes through without a locale rewrite (e.g. /blog, /docs),
 * so an unmatched one never reaches the [locale] tree and its not-found
 * boundary. Next renders this module alone for the `/_not-found` route —
 * no root layout exists above the [locale] segment — so it brings its own
 * document shell (the [locale] boundary renders the same UI inside it).
 *
 * It must own the document title itself: the route metadata of a
 * client-side navigation to an unmatched URL is this module's, and a
 * client-side navigation never re-resolves metadata beyond the route it
 * lands on (that is the stale-title bug this page exists to fix).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi');
  return {
    title: `${t.raw('autoAppNotFoundJsxText404PageNotFoundf7ea8161')} | ${siteMetadata.name}`,
  };
}

/**
 * It also brings its own `NextIntlClientProvider`: the client `NotFoundState`
 * calls `useTranslations`, and without a provider next-intl throws an Error
 * with an empty message in production. That failed every render of this page:
 * the response was Next's error document, and each 404 logged an empty
 * `Error:` (a POST to an unknown path answered 500).
 */
const NotFound = async () => {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} translate="no" suppressHydrationWarning>
      <body className="notranslate text-foreground bg-background flex min-h-dvh w-full scroll-smooth flex-col font-sans font-medium tracking-normal antialiased">
        <NextIntlClientProvider locale={locale} messages={notFoundMessages(messages)} timeZone="UTC">
          <NotFoundBoundary />
        </NextIntlClientProvider>
      </body>
    </html>
  );
};

export default NotFound;
