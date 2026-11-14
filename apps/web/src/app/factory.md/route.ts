import { setupGuide } from '@kortix/shared/setup-guide';
import { composeTemplateOnboarding } from '@kortix/starter/templates';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';
import { serverSetupTarget } from '@/lib/setup-target';

// The guide the Software Factory prompt points at (`FACTORY_PROMPT`): the
// template's own onboarding, then the setup guide. Same text as
// `kortix templates onboard software-factory`.
// Per deployment: the guide names this deployment's own origin and API.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(composeTemplateOnboarding('software-factory', setupGuide(serverSetupTarget())), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
