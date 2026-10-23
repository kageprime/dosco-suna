/** Provider-edge refusals are distinct from the sandbox's signed-context gate. */
export async function isProviderIngressAuthFailure(provider: string, response: Response): Promise<boolean> {
  // E2B's edge rejects a cached traffic token after the sandbox resumed (the
  // resume mints a NEW token) with a 403 body that names the header — JSON from
  // non-browser-shaped requests ("Sandbox is secured with traffic access
  // token.\nToken header 'e2b-traffic-access-token' is missing" / "... is
  // invalid") or an HTML page replying the same sentences. Both heal the same
  // way the Daytona 401 below does: drop the cached preview link and re-resolve
  // once. Without this, every request during the whole link-cache TTL kept
  // replaying the rotated-during-resume token, so the preview showed E2B's 403
  // page (a dosco prod sandbox that had resumed mid-serve, 2026-10-23).
  if (provider === 'e2b') {
    if (response.status !== 403) return false;
    const body = await response.clone().text().catch(() => '');
    return body.includes('e2b-traffic-access-token');
  }
  if (provider !== 'daytona') return false;
  if (response.status >= 300 && response.status < 400) {
    try {
      const location = new URL(response.headers.get('location') ?? '');
      return location.origin === 'https://api.auth.daytona.io'
        && location.pathname === '/user_management/authorize';
    } catch {
      return false;
    }
  }
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null);
  return body?.statusCode === 401 && body?.code === 'UNAUTHORIZED'
    && typeof body?.message === 'string'
    && body.message.startsWith('unauthorized: authentication failed:');
}
