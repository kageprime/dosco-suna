/**
 * The list pages' search: one case-insensitive substring match over each
 * row's own text fields (name, title, key), and the one empty-result line.
 * The Schedules page's `SearchListHeader` filter, shared by Secrets, Apps,
 * Files and the rest.
 */

/** The query as the match reads it: trimmed and lower-cased. Empty = no filter. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** True when any field contains the query, case-insensitive. An empty query matches all. */
export function matchesQuery(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  return fields.some((field) => !!field && field.toLowerCase().includes(q));
}

/** The items whose fields match. Returns `items` itself for an empty query. */
export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
): readonly T[] {
  if (!normalizeQuery(query)) return items;
  return items.filter((item) => matchesQuery(query, fields(item)));
}

/** The empty state of a search that matched nothing: `No results for "<query>"`. */
export function noResultsLabel(query: string): string {
  return `No results for "${query.trim()}"`;
}
