import { describe, expect, test } from 'bun:test';
import { getBlumeDocsOutputPaths } from './blume-docs.mjs';

describe('getBlumeDocsOutputPaths', () => {
  test('names the two files that prove the docs build landed', () => {
    const paths = getBlumeDocsOutputPaths();
    expect(paths.some((p) => p.endsWith('public/docs/index.html'))).toBe(true);
    expect(paths.some((p) => p.endsWith('public/docs/audit-actions/index.html'))).toBe(true);
  });
});

// Assert the generated document, not a copy of Blume's title-template logic.
describe('built docs document titles', () => {
  test('names the home page once and preserves the inner-page suffix', async () => {
    const { buildBlumeDocs } = await import('./blume-docs.mjs');
    buildBlumeDocs();
    const home = await Bun.file(new URL('../public/docs/index.html', import.meta.url)).text();
    const inner = await Bun.file(new URL('../public/docs/audit-actions/index.html', import.meta.url)).text();
    expect(home.match(/<title>(.*?)<\/title>/)?.[1]).toBe('Docs - Kortix CompanyOS');
    expect(inner.match(/<title>(.*?)<\/title>/)?.[1]).toBe('Audit actions - Kortix CompanyOS');
  }, 120_000);
});

// The shipped search index against the shipped pages: a section result must
// open at its heading, so its `#id` has to be an id the built page renders.
describe('built docs search index', () => {
  test('links each h2/h3 section to the heading id on its page', async () => {
    const { buildBlumeDocs } = await import('./blume-docs.mjs');
    buildBlumeDocs();
    const docsRoot = new URL('../public/docs/', import.meta.url);
    const documents: { route: string; title: string }[] = await Bun.file(new URL('blume-search.json', docsRoot)).json();
    expect(documents.find((doc) => doc.title === 'Sessions from code')?.route).toBe('/developers#sessions-from-code');
    const sections = documents.filter((doc) => doc.route.includes('#'));
    expect(sections.length).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const { route } of sections) {
      const [page, id] = route.split('#');
      const html = await Bun.file(new URL(`.${page.replace(/\/?$/, '/')}index.html`, docsRoot)).text();
      if (!html.includes(`id="${id}"`)) missing.push(route);
    }
    expect(missing).toEqual([]);
  }, 120_000);
});
