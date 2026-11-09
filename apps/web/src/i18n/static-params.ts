import { defaultLocale, locales } from './config';

/**
 * `generateStaticParams` for the `[locale]` root segment. Layouts of the public
 * marketing and SEO route groups export it, so each of their pages prerenders
 * once per locale. App routes do not, so they render per request.
 *
 * On Vercel builds, prerender the primary locale ('en') statically to stay
 * within the 8 GB container memory limit. Other locales render on-demand via ISR
 * on the first request and are cached at Vercel's global edge CDN.
 */
export function localeStaticParams(): { locale: string }[] {
  if (process.env.VERCEL) {
    return [{ locale: defaultLocale }];
  }
  return locales.map((locale) => ({ locale }));
}
