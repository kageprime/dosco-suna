import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Characterization for the public share chrome: the h-12 bar (logo, title,
// actions), the rounded sheet under it, and the quiet AuthFrame unavailable
// block. The loaders and the translator are synthetic; the rendered page
// markup is the real thing.
mock.module('server-only', () => ({}));

const realServer = await import('next-intl/server');
mock.module('next-intl/server', () => ({ ...realServer, getLocale: async () => 'en' }));

let artifactResult: Record<string, unknown> = { kind: 'missing' };
let responseResult: Record<string, unknown> = { kind: 'missing' };

mock.module('@/i18n/get-translations', () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => 'en',
}));
mock.module('./artifact/[id]/public-artifact', () => ({
  loadPublicArtifact: async () => artifactResult,
}));
mock.module('./response/[token]/public-response', () => ({
  loadPublicResponse: async () => responseResult,
  plainTextExcerpt: () => 'Synthetic excerpt',
}));

// bun hoists static imports above the mocks, so both pages load dynamically.
const ArtifactPage = (await import('./artifact/[id]/page')).default;
const ResponsePage = (await import('./response/[token]/page')).default;

const SHARED_ARTIFACT = {
  kind: 'shared',
  artifact: {
    title: 'Synthetic artifact',
    description: null,
    content_url: 'https://cdn.example.test/synthetic.html',
  },
};
const SHARED_RESPONSE = {
  kind: 'shared',
  response: {
    title: 'Synthetic response',
    markdown: '# Synthetic heading',
    prompt: 'Synthetic prompt',
    responded_at: '2026-01-01T00:00:00.000Z',
  },
};

let lastHtml: string | undefined;
afterEach(() => {
  lastHtml = undefined;
});

/** Render the async server page component and hand its markup to happy-dom. */
async function renderPage<P>(Page: (props: P) => Promise<ReactElement>, props: P) {
  const html = renderToStaticMarkup(await Page(props));
  lastHtml = html;
  const document = new Window().document;
  document.body.innerHTML = html;
  return document;
}

describe('public share chrome', () => {
  test('the artifact page renders the bar, the sheet and the sandboxed iframe', async () => {
    artifactResult = SHARED_ARTIFACT;
    const document = await renderPage(ArtifactPage, {
      params: Promise.resolve({ locale: 'en', id: 'synthetic' }),
    });
    const main = document.querySelector('main');
    expect(main?.className.replace(/\s+/g, ' ').trim()).toBe(
      'bg-card text-foreground flex h-dvh flex-col',
    );
    const header = main?.querySelector('header');
    expect(header?.className.replace(/\s+/g, ' ').trim()).toBe(
      'flex h-12 shrink-0 items-center gap-3 pr-3 pl-4',
    );
    expect(header?.querySelector('h1')?.textContent).toBe('Synthetic artifact');
    expect(header?.querySelector('a')?.getAttribute('href')).toBe('/');
    const sheet = main?.querySelector('section');
    expect(sheet?.className.replace(/\s+/g, ' ').trim()).toBe(
      'bg-background border-border relative min-h-0 flex-1 overflow-hidden rounded-t-md border-x border-t',
    );
    const iframe = sheet?.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('https://cdn.example.test/synthetic.html');
    expect(iframe?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    );
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(lastHtml).toMatchSnapshot();
  });

  test('the response page renders the bar, the date and the scrollable sheet', async () => {
    responseResult = SHARED_RESPONSE;
    const document = await renderPage(ResponsePage, {
      params: Promise.resolve({ locale: 'en', token: 'synthetic' }),
    });
    const main = document.querySelector('main');
    expect(main?.className.replace(/\s+/g, ' ').trim()).toBe(
      'bg-card text-foreground flex h-dvh flex-col',
    );
    expect(main?.querySelector('header h1')?.textContent).toBe('Synthetic response');
    const sheet = main?.querySelector('section');
    expect(sheet?.className.replace(/\s+/g, ' ').trim()).toBe(
      'bg-background border-border relative min-h-0 flex-1 overflow-y-auto rounded-t-md border-x border-t',
    );
    // The date renders in the page's locale; the prompt stays quoteable.
    expect(document.querySelector('article p')?.textContent).toMatch(/Jan|2026/);
    expect(lastHtml).toContain('Synthetic prompt');
    expect(lastHtml).toContain('Synthetic heading');
    expect(lastHtml).toMatchSnapshot();
  });

  test('an unavailable artifact shows the quiet auth frame block', async () => {
    artifactResult = { kind: 'missing' };
    const document = await renderPage(ArtifactPage, {
      params: Promise.resolve({ locale: 'en', id: 'synthetic' }),
    });
    expect(document.body.textContent).toContain('notFoundTitle');
    expect(document.body.textContent).toContain('notFoundHint');
    // The auth frame renders its own canvas; no share chrome around it.
    expect(document.querySelector('header')).toBeNull();
    expect(document.querySelector('section iframe')).toBeNull();
    expect(lastHtml).toMatchSnapshot();
  });

  test('a revoked response shows the gone block, a busy one the busy block', async () => {
    responseResult = { kind: 'revoked' };
    const revoked = await renderPage(ResponsePage, {
      params: Promise.resolve({ locale: 'en', token: 'synthetic' }),
    });
    expect(revoked.body.textContent).toContain('goneTitle');
    expect(revoked.body.textContent).toContain('goneHint');
    expect(lastHtml).toMatchSnapshot();
    responseResult = { kind: 'busy' };
    const busy = await renderPage(ResponsePage, {
      params: Promise.resolve({ locale: 'en', token: 'synthetic' }),
    });
    expect(busy.body.textContent).toContain('busyTitle');
    expect(busy.body.textContent).toContain('busyHint');
    expect(lastHtml).toMatchSnapshot();
  });
});
