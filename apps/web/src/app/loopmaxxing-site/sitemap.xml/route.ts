import { renderLoopmaxxingSitemap } from '@/features/marketing/one-prompt/seo';
import { loopmaxxingState } from '@/lib/loopmaxxing-gate';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

/** loopmaxxing.sh/sitemap.xml: the middleware rewrites it here. */
export async function GET(): Promise<Response> {
  if (!(await loopmaxxingState()).enabled) return new Response('Not found', { status: 404 });
  return new Response(renderLoopmaxxingSitemap(), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Type': 'application/xml; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
