/**
 * The palette's own match rule, one pair for every palette group: the query's
 * words, and a text that has every one of them, order irrelevant.
 */

/** The query's match unit: its words, lowercased, empties dropped. */
export function paletteWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word appears somewhere in the text, order irrelevant. */
export function matchesAllWords(text: string, words: string[]): boolean {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
