import { ANTIGRAVITY_HUB_USER_AGENT } from '@kortix/llm-gateway/transports/ai-sdk/cloudcode';

export { ANTIGRAVITY_HUB_USER_AGENT };

const CLOUDCODE_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUDCODE_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const;

function extractCompanionProject(data: any): string | null {
  const p = data?.cloudaicompanionProject;
  if (typeof p === 'string' && p) return p;
  if (p && typeof p === 'object') {
    const id = p.id ?? p.projectId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

function pickOnboardingTier(loadJson: any): string {
  const tiers = Array.isArray(loadJson?.allowedTiers) ? loadJson.allowedTiers : [];
  const defaultTier = tiers.find((t: any) => t?.isDefault === true && typeof t?.id === 'string' && t.id);
  if (defaultTier) return defaultTier.id;
  const firstTier = tiers.find((t: any) => typeof t?.id === 'string' && t.id);
  if (firstTier) return firstTier.id;
  if (typeof loadJson?.currentTier?.id === 'string' && loadJson.currentTier.id) {
    return loadJson.currentTier.id;
  }
  return 'free-tier';
}

/**
 * Discovers the Cloud Code companion project via `loadCodeAssist`, falling back
 * to `onboardUser` provisioning (with LRO polling) when a user has not yet
 * been assigned a companion project.
 */
export async function discoverAntigravityProject(
  accessToken: string,
  opts?: { onboard?: boolean; pollDelayMs?: number },
): Promise<string | null> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': ANTIGRAVITY_HUB_USER_AGENT,
  };
  try {
    const res = await fetch(`${CLOUDCODE_DAILY}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata: CLOUDCODE_METADATA }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => ({}));
    const existing = extractCompanionProject(json);
    if (existing) return existing;

    if (opts?.onboard === false) return null;

    const tierId = pickOnboardingTier(json);
    const onboardRes = await fetch(`${CLOUDCODE_DAILY}/v1internal:onboardUser`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tierId, metadata: CLOUDCODE_METADATA }),
      signal: AbortSignal.timeout(8000),
    });
    if (!onboardRes.ok) return null;

    let op: any = await onboardRes.json().catch(() => ({}));
    const immediate = extractCompanionProject(op?.response);
    if (immediate) return immediate;

    const delayMs = opts?.pollDelayMs ?? 1000;
    for (let attempt = 0; attempt < 5 && !op?.done && typeof op?.name === 'string' && op.name; attempt++) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const pollRes = await fetch(`${CLOUDCODE_DAILY}/v1internal/${op.name.replace(/^\/+/, '')}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'user-agent': ANTIGRAVITY_HUB_USER_AGENT,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!pollRes.ok) break;
      op = await pollRes.json().catch(() => ({}));
      const polled = extractCompanionProject(op?.response);
      if (polled) return polled;
    }

    return extractCompanionProject(op?.response);
  } catch {
    return null;
  }
}
