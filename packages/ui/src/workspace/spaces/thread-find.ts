/**
 * Find in a thread: every case-insensitive match of `query` in the text under
 * `root`, as DOM ranges, in reading order. Text people type into (the reply
 * box, inputs) is not searched.
 */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle || typeof document === 'undefined') return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || parent.closest('textarea, input, [contenteditable="true"], [aria-hidden="true"], script, style')) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent!.toLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

const ALL = 'kx-thread-find';
const ACTIVE = 'kx-thread-find-active';

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

function registry(): { highlights: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null;
}

/**
 * Paints the matches (CSS Custom Highlight API, `::highlight(...)`) and the
 * current one apart. Where the browser lacks the API, nothing is painted and
 * the current match still scrolls into view.
 */
export function paintMatches(ranges: readonly Range[], active: number): void {
  const api = registry();
  if (api) {
    api.highlights.set(ALL, new api.Highlight(...ranges));
    const current = ranges[active];
    if (current) api.highlights.set(ACTIVE, new api.Highlight(current));
    else api.highlights.delete(ACTIVE);
  }
  ranges[active]?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function clearMatches(): void {
  const api = registry();
  api?.highlights.delete(ALL);
  api?.highlights.delete(ACTIVE);
}

/** The highlight colours, by the theme's own tokens. */
export const FIND_HIGHLIGHT_CSS = `::highlight(${ALL}){background-color:color-mix(in oklch,var(--kortix-orange) 30%,transparent);color:inherit}::highlight(${ACTIVE}){background-color:var(--kortix-orange);color:var(--background)}`;
