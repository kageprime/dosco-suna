/**
 * Artifacts on mobile: the rules the Artifacts page, the viewer sheet and a
 * session's `show` rows share. Pure: no React or React Native imports
 * (unit-tested under bun test).
 *
 * An artifact is a `doc` or an `html` page in the project's Drive. The viewer
 * loads `version.view_url`, a signed content URL (`/v1/artifacts/s/<token>/`):
 * it needs no Authorization header and no cookie, and a doc comes back already
 * rendered as styled, theme-aware HTML. That URL is a bearer capability, valid
 * 12–18 h. Never share, log or persist it: share `public_url` or `web_url`.
 */

import { parseArtifactUrl, type Artifact, type ArtifactListScope } from '@kortix/sdk';

/** The scope chips above the list, web's gallery filters in the same order. */
export const ARTIFACT_SCOPES: readonly ArtifactListScope[] = ['all', 'mine', 'shared', 'pinned'];

/**
 * The part of a content URL every page of one artifact lives under: the signed
 * `/v1/artifacts/s/<token>/` or the public `/v1/artifacts/p/<id>/` directory,
 * with origin. Null for any other URL: the viewer then refuses to load it.
 */
export function artifactContentPrefix(viewUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(viewUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const match = /^(.*?\/artifacts\/(?:s|p)\/[^/?#]+)(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  return `${url.origin}${match[1]}/`;
}

export type ArtifactNavigation = 'allow' | 'open-external' | 'block';

/**
 * Where a navigation inside the artifact viewer goes.
 * - inside the artifact's own content directory → `allow` (its other pages,
 *   assets, a deck's next slide);
 * - an http(s) frame inside the page (`isTopFrame === false`: an embedded
 *   video or map) → `allow`;
 * - any other top-frame http(s) or mailto URL → `open-external`, in the
 *   in-app browser. Android reports no tap signal, so a redirect opens there
 *   too (Jay, 2026-11-11: open externally, never a dead link);
 * - every other scheme (javascript:, intent:, app deep links, file:) → `block`.
 */
export function decideArtifactNavigation(
  url: string,
  prefix: string,
  options: { isTopFrame?: boolean } = {},
): ArtifactNavigation {
  const lower = url.trim().toLowerCase();
  if (lower === 'about:blank' || lower === 'about:srcdoc') return 'allow';
  if (lower.startsWith('data:') || lower.startsWith('blob:')) return 'allow';
  const isWeb = lower.startsWith('https://') || lower.startsWith('http://');
  if (isWeb) {
    // The token sits in the path: compare it exactly, scheme and host case-folded.
    if (normalizeOrigin(url).startsWith(normalizeOrigin(prefix))) return 'allow';
    if (options.isTopFrame === false) return 'allow';
    return 'open-external';
  }
  if (lower.startsWith('mailto:')) return 'open-external';
  return 'block';
}

/** Lower-case the scheme and host only: the path (the signed token) is case-sensitive. */
function normalizeOrigin(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(url.trim());
  return match ? match[1].toLowerCase() + match[2] : url.trim();
}

/**
 * The link Share sends: the public page when the artifact is public, else the
 * app link, which opens only for people who may view it. Never `view_url`.
 */
export function artifactShareUrl(artifact: Pick<Artifact, 'visibility' | 'public_url' | 'web_url'>): string {
  if (artifact.visibility === 'public' && artifact.public_url) return artifact.public_url;
  return artifact.web_url;
}

/**
 * The artifact a `show` URL or a message link names, when the viewer here can
 * open it: an app link into THIS project. A public share link, a link into
 * another project, or any other URL returns null and keeps its current path
 * (the in-app browser). The host is not checked: the viewer never loads the
 * link itself, it reads the artifact by id through the caller's own access.
 */
export function artifactInProject(url: string, projectId: string | null | undefined): string | null {
  if (!url || !projectId) return null;
  const parsed = parseArtifactUrl(url);
  if (!parsed || !parsed.projectId) return null;
  return parsed.projectId === projectId.toLowerCase() ? parsed.artifactId : null;
}

/** Which line the list shows when it has no rows. */
export function artifactsEmptyState({
  query,
  scope,
}: {
  query: string;
  scope: ArtifactListScope;
}): 'none' | 'no-match' | 'scope-empty' {
  if (query.trim()) return 'no-match';
  return scope === 'all' ? 'none' : 'scope-empty';
}

/**
 * An HTTP status from the artifact page. A refused or missing signed URL
 * (403, 404, 410) may only have expired: read the artifact again once for a
 * fresh `view_url`. Anything else, or a second failure, shows the error.
 */
export function artifactHttpErrorAction(status: number, alreadyRetried: boolean): 'refresh' | 'error' {
  if (alreadyRetried) return 'error';
  return status === 403 || status === 404 || status === 410 ? 'refresh' : 'error';
}
