/**
 * The change requests an agent's reply links to: a Review link carries the
 * item as `id=cr:<cr_id>` (`/inbox?view=review&id=cr:…`, `/review?id=cr:…`),
 * the colon often percent-encoded. In first-seen order, each once, at most
 * `MAX_LINKED_CHANGE_REQUESTS`: a reply that lists many is a report, not a
 * decision, and a card per link would bury it.
 */
export const MAX_LINKED_CHANGE_REQUESTS = 3;

const CR_LINK = /[?&]id=cr(?::|%3A)([A-Za-z0-9_-]+)/gi;

export function linkedChangeRequestIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(CR_LINK)) {
    const id = match[1]!;
    if (!ids.includes(id)) ids.push(id);
    if (ids.length === MAX_LINKED_CHANGE_REQUESTS) break;
  }
  return ids;
}
