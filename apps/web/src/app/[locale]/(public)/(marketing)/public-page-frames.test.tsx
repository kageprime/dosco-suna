import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';

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

// Under bun test there is no react-server bundler condition; neutralize the
// guard package. The rendered markup below stays the real thing.
mock.module('server-only', () => ({}));

// Bun does not compile MDX frontmatter. Supply the content boundary, not a
// page or section mock, so the actual shipped composition still renders end
// to end (same boundary `route-composition.test.tsx` supplies).
mock.module('@/lib/use-cases-source', () => ({
  useCasesSource: {
    getPages: () => [
      {
        slugs: ['synthetic-report'],
        url: '/use-cases/synthetic-report',
        data: {
          title: 'Synthetic report',
          description: 'A test report',
          date: '2026-01-01',
          tags: ['Finance'],
          author: 'kortix',
        },
      },
    ],
  },
}));

// bun hoists static imports above the mocks, so every page loads dynamically.
const Home = (await import('./(home)/page')).default;
const PricingPage = (await import('./pricing/page')).default;
const SecurityPage = (await import('./security/page')).default;
const DesktopPage = (await import('./desktop/page')).default;

const dom = (html: string) => {
  const document = new Window().document;
  document.body.innerHTML = html;
  return document;
};

/** Class tokens of an element, whitespace-normalized and ordered. */
const tokens = (node: { className: string }) =>
  node.className.replace(/\s+/g, ' ').trim().split(' ').sort().join(' ');

/** The two hairline rails every full marketing page draws, 62px in on desktop. */
const railTokens = (document: ReturnType<typeof dom>) =>
  [...document.querySelectorAll('main > div[aria-hidden]')].map(tokens);

const RAIL_LEFT = 'absolute bg-border inset-y-0 left-4 lg:left-17 pointer-events-none w-px z-10';
const RAIL_RIGHT = 'absolute bg-border inset-y-0 lg:right-17 pointer-events-none right-4 w-px z-10';
const MAIN_FRAME = 'bg-background max-w-[1440px] mx-auto relative w-full';

describe('full marketing pages render in the landing frame', () => {
  for (const [name, Page] of [
    ['home', Home],
    ['pricing', PricingPage],
    ['security', SecurityPage],
    ['desktop', DesktopPage],
  ] as const) {
    test(`${name} keeps the 1440 column and its two hairline rails`, () => {
      const document = dom(renderToStaticMarkup(<Page />));
      const main = document.querySelector('main');
      expect(main ? tokens(main) : null).toBe(MAIN_FRAME);
      expect(railTokens(document)).toEqual([RAIL_LEFT, RAIL_RIGHT]);
    });

    test(`${name} draws every band's hairlines across the page`, () => {
      const document = dom(renderToStaticMarkup(<Page />));
      const bands = [...document.querySelectorAll('.kx-rail-fade')];
      expect(bands.length).toBeGreaterThan(0);
      for (const band of bands) {
        const classes = tokens(band).split(' ');
        // The hairlines cross the page (`border-y`) or hang from the band
        // above (`border-b`, the strips that sit flush under a band).
        expect(classes.some((c) => c === 'border-y' || c === 'border-b')).toBe(true);
      }
    });
  }

  test('pricing keeps the plan columns, compare table and section headings', () => {
    const document = dom(renderToStaticMarkup(<PricingPage />));
    // The three plans land in three columns inside the plans band.
    expect(
      [...document.querySelectorAll('#plans div, #plans ul')].some((node) =>
        node.className.replace(/\s+/g, ' ').includes('lg:grid-cols-3'),
      ),
    ).toBe(true);
    // The compare table keeps its four columns (label + three plans).
    expect(document.querySelectorAll('#compare thead th').length).toBe(4);
    // The agent-hours split keeps its 7/5 grid.
    expect(
      [...document.querySelectorAll('#agent-hours div')].some((node) =>
        node.className.replace(/\s+/g, ' ').includes('lg:grid-cols-12'),
      ),
    ).toBe(true);
    // The section headings stay two-tone h2s with a muted second line, and
    // every band keeps the padded inner measure the kit Band paints.
    expect(document.querySelectorAll('h2').length).toBeGreaterThanOrEqual(4);
    for (const band of [
      ...document.querySelectorAll(
        '#plans .kx-rail-fade, #agent-hours .kx-rail-fade, #models .kx-rail-fade, #compare .kx-rail-fade',
      ),
    ]) {
      const classes = tokens(band).split(' ');
      expect(classes).toContain('px-4');
      expect(classes).toContain('lg:px-17');
    }
  });

  test('security keeps the four-pillar grid, the enforcement table and the dark trust band', () => {
    const document = dom(renderToStaticMarkup(<SecurityPage />));
    expect(document.querySelectorAll('#pillars h3').length).toBe(4);
    expect(document.querySelectorAll('#enforcement tbody tr').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#trust .dark').length).toBe(1);
  });

  test('home keeps its section composition', () => {
    const document = dom(renderToStaticMarkup(<Home />));
    const sections = [...document.querySelectorAll('main section, main > div')];
    expect(sections.length).toBeGreaterThanOrEqual(8);
  });

  test('desktop keeps the surface page composition', () => {
    const document = dom(renderToStaticMarkup(<DesktopPage />));
    expect(document.querySelectorAll('main section').length).toBeGreaterThanOrEqual(4);
  });
});
