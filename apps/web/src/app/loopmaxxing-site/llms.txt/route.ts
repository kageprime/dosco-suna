import { renderLoopmaxxingLlmsTxt } from '@/features/marketing/one-prompt/seo';
import { loopmaxxingState } from '@/lib/loopmaxxing-gate';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';

/** loopmaxxing.sh/llms.txt and /llms-full.txt: the middleware rewrites both here. */
export async function GET(): Promise<Response> {
  if (!(await loopmaxxingState()).enabled) return new Response('Not found', { status: 404 });
  return new Response(renderLoopmaxxingLlmsTxt(), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
