import { setupGuide } from '@kortix/shared/setup-guide';
import { composeTemplateOnboarding, isTemplateId } from '@kortix/starter/templates';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';
import { serverSetupTarget } from '@/lib/setup-target';

// kortix.com/loops/<id>.md: the guide one loop's prompt points at (`loopPrompt`).
// Same text as `kortix templates onboard <id>`.
// Per deployment: the guide names this deployment's own origin and API.
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const id = (await params).file.replace(/\.md$/, '');
  if (!isTemplateId(id)) return new Response('Not found', { status: 404 });
  return new Response(composeTemplateOnboarding(id, setupGuide(serverSetupTarget())), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
