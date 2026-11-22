import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';

/**
 * The docs "On this page" scrollspy is Blume's <blume-toc> element
 * (blume/src/components/layout/toc-element.ts, patched in
 * patches/blume@1.5.3.patch). A deep link such as /docs/developers#cli lands
 * the heading at the theme's scroll-padding-top (72px) plus a sub-pixel
 * remainder: Chrome measured 72.27px for #billing and 72.11px for #teams. The
 * spy must count that heading as reached, or it marks the previous section
 * until the reader scrolls (KRTX-4959).
 */

const win = new Window({ innerWidth: 1280, innerHeight: 800 });
const saved = {
  window: globalThis.window,
  document: globalThis.document,
  CSS: globalThis.CSS,
  IntersectionObserver: globalThis.IntersectionObserver,
};

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    window: { value: win, configurable: true, writable: true },
    document: { value: win.document, configurable: true, writable: true },
    CSS: { value: { escape: (value: string) => value }, configurable: true, writable: true },
    // The spy's observer only re-triggers the same rect check; the test
    // calls that check through connectedCallback, so the observer is inert.
    IntersectionObserver: {
      value: class {
        observe() {}
        disconnect() {}
      },
      configurable: true,
      writable: true,
    },
  });
  // The element ships as source (RootLayout imports it), not as a package export.
  await import('../node_modules/blume/src/components/layout/toc-element');
});

afterAll(() => {
  Object.defineProperties(globalThis, {
    window: { value: saved.window, configurable: true, writable: true },
    document: { value: saved.document, configurable: true, writable: true },
    CSS: { value: saved.CSS, configurable: true, writable: true },
    IntersectionObserver: { value: saved.IntersectionObserver, configurable: true, writable: true },
  });
});

/**
 * Renders two sections and an outline, the second section's elements at the
 * given tops (px, by id), and returns the label the spy marks.
 */
function currentAfterLanding(tops: Record<string, number>, secondSection = '<h2 id="cli">CLI</h2>'): string | null {
  const doc = win.document;
  doc.body.innerHTML = `<h2 id="agent-tools">Agent tools</h2>${secondSection}`;
  const all: Record<string, number> = { 'agent-tools': -4000, ...tops };
  for (const element of doc.querySelectorAll('[id]')) {
    element.getBoundingClientRect = () => new win.DOMRect(0, all[element.id], 600, 32);
  }
  Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 100_000, configurable: true });
  const toc = doc.createElement('blume-toc');
  toc.innerHTML = '<a href="#agent-tools">Agent tools</a><a href="#cli">CLI</a>';
  doc.body.append(toc);
  const label = toc.querySelector('a[aria-current="location"]')?.textContent ?? null;
  toc.remove();
  return label;
}

describe('docs scrollspy after a deep link', () => {
  test('marks the section whose heading the hash scroll landed at 72px plus a sub-pixel remainder', () => {
    expect(currentAfterLanding({ cli: 72.27 })).toBe('CLI');
    expect(currentAfterLanding({ cli: 72.11 })).toBe('CLI');
  });

  test('marks the section whose heading is exactly at or above the trigger line', () => {
    expect(currentAfterLanding({ cli: 72 })).toBe('CLI');
    expect(currentAfterLanding({ cli: 10 })).toBe('CLI');
  });

  test('keeps the previous section while the next heading is still a pixel or more below the line', () => {
    expect(currentAfterLanding({ cli: 73.5 })).toBe('Agent tools');
    expect(currentAfterLanding({ cli: 400 })).toBe('Agent tools');
  });

  test('starts a section at the legacy anchor placed right before its heading', () => {
    // /docs/guide#automations lands the anchor before "## Triggers" at the
    // line; the heading itself sits one heading margin (32px) below it.
    const aliased = '<a id="automations"></a><h2 id="cli">CLI</h2>';
    expect(currentAfterLanding({ automations: 72.2, cli: 104 }, aliased)).toBe('CLI');
    expect(currentAfterLanding({ automations: 300, cli: 332 }, aliased)).toBe('Agent tools');
  });
});

describe('legacy anchors that alias a heading', () => {
  // A published link such as /docs/guide#teams must land on its section's
  // heading. An anchor placed right after the heading lands the paragraph
  // under it at the trigger line, so the heading sits under the 64px sticky
  // header (6px from the top for #teams). Such an anchor goes right before its
  // heading instead, as the guide's #a-backend-for-agents does.
  const root = path.join(import.meta.dir, '../content/docs');
  const pages = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.mdx'));

  test.each(pages)('%s has no anchor between a heading and its text', (page) => {
    const lines = readFileSync(path.join(root, page), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('{/*'));
    const isAnchor = (line: string) => /^<a id="[^"]+" \/>$/.test(line);
    const isHeading = (line: string) => /^#{2,6} /.test(line);
    const misplaced: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!isAnchor(lines[i]) || !isHeading(lines[i - 1])) continue;
      let next = i;
      while (next < lines.length && isAnchor(lines[next])) next++;
      // Anchors that precede the next heading alias that heading: fine.
      if (!isHeading(lines[next] ?? '')) misplaced.push(`${lines[i - 1]} -> ${lines[i]}`);
    }
    expect(misplaced).toEqual([]);
  });
});
