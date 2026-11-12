import { notFound } from 'next/navigation';
import { getRequestConfig } from 'next-intl/server';
import { locale as rootLocale } from 'next/root-params';
import { defaultLocale } from './config';
import { normalizeLocale } from './locale';
import { loadMessages } from './messages';

/**
 * The locale comes from the URL, never from the request.
 *
 * Every page lives under `app/[locale]`. The middleware rewrites the public
 * URL onto that segment: an explicit `/de/...` prefix, else the profile locale
 * of the signed-in user, else English. `next/root-params` reads the segment
 * without `headers()` or `cookies()`, so marketing pages render statically,
 * once per locale.
 *
 * Server Actions and Route Handlers have no root params. They fall back to the
 * `X-NEXT-INTL-LOCALE` request header that the middleware sets on the rewrite.
 * Those surfaces are request-bound already, so the header read costs nothing.
 */
/**
 * The `[locale]` segment of this render: a string under `app/[locale]`,
 * `undefined` on a route without it (the root `/_not-found`), `null` where
 * root params do not exist (Server Actions, Route Handlers).
 */
async function readRootLocaleSegment(): Promise<string | undefined | null> {
  try {
    return await rootLocale();
  } catch {
    return null;
  }
}

export default getRequestConfig(async (params) => {
  const segment = await readRootLocaleSegment();
  if (typeof segment === 'string') {
    // Any first path segment matches app/[locale] (`/general/use-cases/x`).
    // An unknown one is a 404, as in the [locale] layout. The header fallback
    // below must not run here: it reads headers() inside a static page, and
    // Next fails that render with a 500 ("changed from static to dynamic").
    const locale = normalizeLocale(segment);
    if (!locale) notFound();
    return { locale, messages: await loadMessages(locale) };
  }
  // Do NOT destructure `requestLocale`: it is a getter that reads headers(),
  // and touching it opts every page into dynamic rendering.
  const locale = normalizeLocale(await params.requestLocale) ?? defaultLocale;
  return { locale, messages: await loadMessages(locale) };
});
