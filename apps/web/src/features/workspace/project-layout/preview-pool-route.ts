/**
 * Which project routes may start the background preview pool
 * (`AppPreviewPoolLoader`, `ArtifactFramePreloader`).
 *
 * The pool loads up to 12 App previews and 12 artifact pages into hidden
 * frames: about half of a full load's API requests (44-51 measured on
 * 2026-11-14). Settings pages never show a pooled frame, and on dev one load
 * of `/admin/roles` sent 89 requests, 44 of them for the pool: four reloads a
 * minute reached the API's 300 requests/min limit, and the settings page
 * itself then failed with 429.
 *
 * So a settings route does not start the pool. The first visit to any other
 * project route starts it, and it stays mounted from then on: frames loaded
 * before a move into settings stay warm, and moving back costs nothing.
 */

/** The project segments whose pages are settings, not content. */
const SETTINGS_SEGMENTS = new Set(['admin', 'settings', 'customize', 'members']);

/** `/[locale]/workspaces/<id>/<segment>/…`: the segment after the project id, else null. */
function projectSegment(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const at = parts.indexOf('workspaces');
  if (at < 0 || parts.length < at + 2) return null;
  return parts[at + 2] ?? '';
}

/** True when this project route may start the preview pool. */
export function previewPoolAllowed(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const segment = projectSegment(pathname);
  if (segment === null) return false;
  return !SETTINGS_SEGMENTS.has(segment);
}
