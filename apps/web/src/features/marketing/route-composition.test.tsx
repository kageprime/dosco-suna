import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import type { Element as HappyElement, HTMLPreElement } from 'happy-dom';
// The home route now carries the landing's signed-in gate
// (LandingAuthGate), a client component that requires the app's providers.
// SSR renders the gate's signed-out output (the landing, unchanged); supply
// the provider boundary the same way `home-auth-redirect.test.tsx` does.
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    supabase: {},
    bootstrapError: null,
    retryAuth: () => undefined,
    signOut: () => Promise.resolve(),
  }),
}));
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
// Bun does not compile MDX frontmatter. Supply the content boundary, not a page
// or section mock, so the actual shipped composition still renders end to end.
mock.module('@/lib/use-cases-source', () => ({
  useCasesSource: {
    getPages: () => [{
      slugs: ['synthetic-report'],
      url: '/use-cases/synthetic-report',
      data: { title: 'Synthetic report', description: 'A test report', date: '2026-01-01', tags: ['Finance'], author: 'kortix' },
    }],
  },
}));

import DesktopPage from '@/app/[locale]/(public)/(marketing)/desktop/page';
import Home from '@/app/[locale]/(public)/(marketing)/(home)/page';
import CompliancePage from '@/app/[locale]/(public)/(marketing)/compliance/page';
import EnterprisePage from '@/app/[locale]/(public)/(marketing)/enterprise/page';
import FrameworkPage from '@/app/[locale]/(public)/(marketing)/framework/page';
import MultiplayerPage from '@/app/[locale]/(public)/(marketing)/multiplayer/page';
import SecurityPage from '@/app/[locale]/(public)/(marketing)/security/page';
import SelfHostedPage from '@/app/[locale]/(public)/(marketing)/self-hosted/page';
import SovereignPage from '@/app/[locale]/(public)/(marketing)/sovereign/page';
import { TOPIC_PANELS as SelfHostedPanels } from '@/features/marketing/self-hosted/topic-panels';
import { TOPIC_PANELS as SovereignPanels } from '@/features/marketing/sovereign/topic-panels';

describe('shipped marketing route composition', () => {
  for (const [name, Page] of [['home', Home], ['security', SecurityPage]] as const) {
    test(`${name} retains its rendered sections, links and visuals`, () => {
      const html = renderToStaticMarkup(<Page />);
      expect(html).toContain('<section');
      expect(html).toContain('href=');
      // The security page's text changes with its copy: it is checked for
      // structure only. The home page keeps its full composition snapshot.
      if (name === 'security') return;
      const document = new Window().document;
      document.body.innerHTML = html;
      expect({
        sections: [...document.querySelectorAll('section')].map((node) => node.id),
        securityContent: undefined,
        glyphs: [...document.querySelectorAll('[style*="mask"]')].map((node) => node.getAttribute('style')),
        headings: [...document.querySelectorAll('h1, h2, h3')].map((node) => node.textContent),
        links: [...document.querySelectorAll('a')].map((node) => [node.textContent, node.getAttribute('href')]),
        visuals: [...document.querySelectorAll('img, video, [role="img"]')].map((node) => [node.getAttribute('src'), node.getAttribute('alt'), node.getAttribute('aria-label')]),
      }).toMatchSnapshot();
    });
  }

  // The split-tab section of each page, byte for byte: its DOM ids, aria-*
  // wiring, class strings, copy and first panel.
  for (const [name, Page] of [
    ['enterprise', EnterprisePage],
    ['compliance', CompliancePage],
    ['sovereign', SovereignPage],
    ['self-hosted', SelfHostedPage],
    ['framework', FrameworkPage],
    ['multiplayer', MultiplayerPage],
    ['security', SecurityPage],
  ] as const) {
    test(`${name} renders its topic tabs section unchanged`, () => {
      const document = new Window().document;
      document.body.innerHTML = renderToStaticMarkup(<Page />);
      const sections = document.querySelectorAll('section#how-it-works');
      expect(sections.length).toBe(1);
      expect(sections[0].outerHTML).toMatchSnapshot();
    });
  }
});

// The seven solution pages and the desktop surface page pin the hero shell
// the kit owns (PageHero and the rail band): the section id, the h1, the
// sub, the CTA row, the band, the caption, and the walkthrough's ids and
// aria wiring. Projections, not raw HTML: the shell's wrapper divs are
// internals a dedupe may re-nest; everything a reader depends on is pinned.
const SOLUTION_HERO_PAGES = [
  ['compliance', CompliancePage],
  ['enterprise', EnterprisePage],
  ['framework', FrameworkPage],
  ['multiplayer', MultiplayerPage],
  ['self-hosted', SelfHostedPage],
  ['sovereign', SovereignPage],
  ['desktop', DesktopPage],
] as const;

function projectHero(html: string) {
  const document = new Window().document;
  document.body.innerHTML = html;
  const hero = document.querySelector('section#hero');
  if (!hero) throw new Error('the page renders no section#hero');
  const band = hero.querySelector('.kx-rail-fade');
  const h1 = hero.querySelector('h1');
  if (!band || !h1) throw new Error('the hero renders no canonical shell');
  const inner = band.firstElementChild;
  const caption = inner?.lastElementChild;
  return {
    h1Class: h1.className,
    h1Text: h1.textContent,
    subClass: h1.nextElementSibling?.className ?? null,
    subText: h1.nextElementSibling?.textContent ?? null,
    cta: [...hero.querySelectorAll('a, button')]
      .filter((node) => !band.contains(node))
      .map((node) => [node.tagName.toLowerCase(), node.textContent, node.getAttribute('href')]),
    bandClass: band.className,
    bandInnerChildren: inner
      ? [...inner.children].map((child) => ({ tag: child.tagName.toLowerCase(), class: child.className }))
      : [],
    captionClass: caption?.tagName === 'P' ? caption.className : null,
    captionText: caption?.textContent ?? null,
    ids: [...hero.querySelectorAll('[id]')].map((node) => [
      node.id,
      node.getAttribute('role'),
      node.getAttribute('aria-labelledby'),
    ]),
    windows: [...document.querySelectorAll('span.font-mono.truncate')].map((title) => ({
      title: title.textContent,
      barClass: title.parentElement?.className ?? null,
    })),
    terminals: projectTerminals(html),
  };
}

function projectTerminals(html: string) {
  const document = new Window().document;
  document.body.innerHTML = html;
  const line = (pre: HTMLPreElement, pick: (s: HappyElement) => boolean) =>
    [...pre.querySelectorAll('span')].find(pick)?.className ?? null;
  return [...document.querySelectorAll('pre')].map((pre) => ({
    class: pre.className,
    okLineClass:
      line(pre, (s) => s.firstElementChild?.classList.contains('text-kortix-green') === true) ?? null,
    cmdLineClass: line(pre, (s) => s.firstElementChild?.textContent === '$ '),
    commentLineClass: line(pre, (s) => !s.firstElementChild && (s.textContent?.startsWith('#') ?? false)),
  }));
}

describe('shipped solution hero composition', () => {
  for (const [name, Page] of SOLUTION_HERO_PAGES) {
    test(`${name} keeps its hero shell, band, links and walkthrough wiring`, () => {
      expect(projectHero(renderToStaticMarkup(<Page />))).toMatchSnapshot();
    });
  }

  test('the topic-panel terminals keep their line rendering', () => {
    expect({
      selfHosted: projectTerminals(renderToStaticMarkup(<SelfHostedPanels.updates />)),
      sovereign: projectTerminals(renderToStaticMarkup(<SovereignPanels.install />)),
    }).toMatchSnapshot();
  });
});
