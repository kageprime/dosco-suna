/** Browser links select a Review item; REST /change-requests paths are not pages. */
export function changeRequestReviewPath(
  workspaceId: string,
  crId: string,
  query = new URLSearchParams(),
): string {
  const selected = new URLSearchParams({ id: `cr:${crId}` });
  for (const [key, value] of query) if (key !== 'id') selected.append(key, value);
  return `/workspaces/${encodeURIComponent(workspaceId)}/review?${selected}`;
}

/** Match the UUID / int4 display-number references the authorized CR API accepts. */
export function normalizeChangeRequestRef(ref: string): string | null {
  // Next's rewritten dynamic segments can retain percent encoding. Decode once only.
  try { ref = decodeURIComponent(ref); } catch { return null; }
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ref)) return ref.toLowerCase();
  const number = ref.replace(/^#/, '');
  return /^\d+$/.test(number) && Number(number) > 0 && Number(number) <= 2_147_483_647
    ? String(Number(number))
    : null;
}
