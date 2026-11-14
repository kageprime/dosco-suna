import { setupGuide } from '@kortix/shared/setup-guide';
import { MACHINE_CONTENT_CACHE_CONTROL } from '@/lib/seo/response';
import { serverSetupTarget } from '@/lib/setup-target';

// The guide the one setup prompt points a coding agent at (`SETUP_PROMPT`).
// Per deployment: the guide names this deployment's own origin and API.
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(setupGuide(serverSetupTarget()), {
    headers: {
      'Cache-Control': MACHINE_CONTENT_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
