import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  cacheMermaidSvg,
  MERMAID_CONFIG,
  MERMAID_SVG_CACHE_MAX,
  readCachedMermaidSvg,
  removeMermaidRenderArtifacts,
  renderMermaidSvg,
} from './mermaid-render';

const RENDERER_SOURCE = readFileSync(new URL('./mermaid-renderer.tsx', import.meta.url), 'utf8');

/** A document with a few named nodes; records which ones were removed. */
function fakeDocument(ids: string[]) {
  const removed: string[] = [];
  const nodes = new Map(ids.map((id) => [id, { remove: () => removed.push(id) }]));
  return {
    doc: { getElementById: (id: string) => (nodes.get(id) ?? null) as unknown as HTMLElement },
    removed,
  };
}

describe('Mermaid render errors stay inside the diagram', () => {
  test('Mermaid does not draw its own error diagram into the page', () => {
    expect(MERMAID_CONFIG.suppressErrorRendering).toBe(true);
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
  });

  test('cleanup removes only the nodes created for this render', () => {
    const { doc, removed } = fakeDocument([
      'app-root',
      'message-with-syntax-error-text',
      'mermaid-1',
      'dmermaid-1',
      'mermaid-2',
    ]);

    removeMermaidRenderArtifacts(doc, 'mermaid-1');

    expect(removed.sort()).toEqual(['dmermaid-1', 'mermaid-1']);
  });

  test('cleanup is a no-op when the render left nothing behind', () => {
    const { doc, removed } = fakeDocument(['app-root']);

    removeMermaidRenderArtifacts(doc, 'mermaid-9');

    expect(removed).toEqual([]);
  });

  test('the renderer never sweeps the whole document', () => {
    expect(RENDERER_SOURCE).not.toContain('document.querySelectorAll');
    expect(RENDERER_SOURCE).not.toContain('setInterval');
  });
});

describe('Mermaid SVG cache', () => {
  test('two different sources never share an entry', () => {
    // These two collide under the old 32-bit `(hash << 5) - hash + c` key.
    cacheMermaidSvg('graph TD\nAa', '<svg>first</svg>');
    cacheMermaidSvg('graph TD\nBB', '<svg>second</svg>');

    expect(readCachedMermaidSvg('graph TD\nAa')).toBe('<svg>first</svg>');
    expect(readCachedMermaidSvg('graph TD\nBB')).toBe('<svg>second</svg>');
  });

  test('keeps at most MERMAID_SVG_CACHE_MAX entries, dropping the least recently used', () => {
    const sources = Array.from({ length: MERMAID_SVG_CACHE_MAX }, (_, i) => `graph LR\nn${i}`);
    for (const source of sources) cacheMermaidSvg(source, `<svg>${source}</svg>`);

    // Reading the oldest makes it the most recent, so the next insert evicts
    // the second oldest instead.
    expect(readCachedMermaidSvg(sources[0])).toBeDefined();
    cacheMermaidSvg('graph LR\nnew', '<svg>new</svg>');

    expect(readCachedMermaidSvg(sources[0])).toBeDefined();
    expect(readCachedMermaidSvg(sources[1])).toBeUndefined();
    expect(readCachedMermaidSvg('graph LR\nnew')).toBe('<svg>new</svg>');
  });
});

describe('Mermaid starter validation', () => {
  test('a source without a diagram type rejects before any render', async () => {
    await expect(renderMermaidSvg('hello world', () => {})).rejects.toThrow(
      'Invalid diagram type. Chart must start with a valid Mermaid diagram type (e.g., graph, flowchart, sequenceDiagram, etc.). Found: "hello world"',
    );
  });

  test('a git command stream is not a diagram type for the renderer', async () => {
    // The git command tail belongs to the fence router, not this validator.
    await expect(renderMermaidSvg('commit id: "a1"', () => {})).rejects.toThrow(
      'Invalid diagram type',
    );
    await expect(renderMermaidSvg('branch feature', () => {})).rejects.toThrow(
      'Invalid diagram type',
    );
  });

  test('a short alias in the first line passes the starter check', async () => {
    // 'sequence' is a renderer alias: past the starter check, the failure (if
    // any) comes from the mermaid render itself, never the type error.
    const error = await renderMermaidSvg('title: my sequence demo', () => {}).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('Invalid diagram type');
  });
});

describe('Mermaid in a streaming message', () => {
  test('the diagram renders a settled source, not every token', () => {
    expect(RENDERER_SOURCE).toContain('useSettledValue(chart.trim(), isStreaming, CODE_SETTLE_MS)');
  });

  test('the renderer does not log on every render', () => {
    expect(RENDERER_SOURCE).not.toContain('console.log');
  });
});
