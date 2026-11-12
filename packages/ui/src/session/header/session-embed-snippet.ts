/**
 * The iframe snippet a host page pastes: the ACTUAL session page
 * (`/projects/:projectId/sessions/:sessionId`), not a separate widget or
 * viewer. Pure, so the test can pin the exact HTML without a browser.
 *
 * The snippet is static HTML by construction: the URL is built from ids, and
 * the `title` attribute is a fixed string. Never interpolate a session title
 * into the attribute — an unescaped quote would break out of it on the HOST
 * page, which does not share this app's CSP.
 *
 * Framing the session page is allowed by the CSP `frame-ancestors` rule on
 * that route (next.config.ts); the viewer inside the frame is the app's own
 * auth. Same-site embeds require an existing signed-in session; cross-site
 * embeds cannot sign in inside the frame (SameSite=Lax and /auth's CSP).
 */
export function sessionEmbedSnippet(projectId: string, sessionId: string, origin: string): string | null {
  if (!projectId || !sessionId || !origin) return null;
  const src = `${origin}/workspaces/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
  return `<iframe src="${src}" style="height:640px;width:100%;border:0;border-radius:12px" title="Kortix session" loading="lazy"></iframe>`;
}
