import { ANTIGRAVITY_HUB_USER_AGENT } from '@kortix/llm-gateway/transports/ai-sdk/cloudcode';

export { ANTIGRAVITY_HUB_USER_AGENT };

const CLOUDCODE_DAILY = 'https://daily-cloudcode-pa.googleapis.com';

/**
 * Discovers the Cloud Code companion project via `loadCodeAssist`. The project
 * is required by the Cloud Code envelope for content calls.
 */
export async function discoverAntigravityProject(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${CLOUDCODE_DAILY}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'user-agent': ANTIGRAVITY_HUB_USER_AGENT,
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => ({}));
    const p = json?.cloudaicompanionProject;
    if (typeof p === 'string' && p) return p;
    if (p && typeof p === 'object') {
      const id = p.id ?? p.projectId;
      if (typeof id === 'string' && id) return id;
    }
    return null;
  } catch {
    return null;
  }
}
