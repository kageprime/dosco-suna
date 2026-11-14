/**
 * The slice of an mdast node this transform reads. Declared here rather than
 * imported from `@types/mdast`, which `apps/web` does not depend on.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/**
 * Turns every single newline inside prose text into a hard line break.
 *
 * CommonMark reads a single `\n` as a soft break and joins the lines with a
 * space. Chat text does not follow that rule: a model that writes one item per
 * line means one item per line. Only `text` nodes change, so code spans, fenced
 * code, math and HTML keep their newlines as written.
 */
export function splitSoftBreaks(tree: MdNode): void {
  const children = tree.children;
  if (!children) return;
  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type === 'text' && child.value?.includes('\n')) {
      const lines = child.value.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (index > 0) next.push({ type: 'break' });
        if (line) next.push({ type: 'text', value: line });
      });
      continue;
    }
    splitSoftBreaks(child);
    next.push(child);
  }
  tree.children = next;
}

/** `splitSoftBreaks` as a remark plugin. Used for chat messages, never documents. */
export function remarkSoftBreaks() {
  return (tree: MdNode) => splitSoftBreaks(tree);
}
