import { describe, expect, mock, test } from 'bun:test';

// Under bun test there is no react-server bundler condition, so the
// `server-only` guard package would throw on the metadata module's
// next-intl/server import. Neutralize it; the metadata logic stays real.
mock.module('server-only', () => ({}));

// `requestLocale()` reads the request scope (`getLocale` from
// next-intl/server), which does not exist under bun test. Pin it to `en`, the
// default prerendered locale, so each layout module resolves its real SEO
// record against the real English catalog.
const nextIntlServer = await import('next-intl/server');
mock.module('next-intl/server', () => ({ ...nextIntlServer, getLocale: async () => 'en' }));

// bun hoists static imports above the mocks, so every route module loads
// dynamically, after the mocks registered. Ten routes host their metadata in
// the page itself (their pass-through layout was deleted); the rest re-export
// from a layout.
const modules = {
  home: await import('@/app/[locale]/(public)/(marketing)/(home)/page'),
  'case-studies': await import('@/app/[locale]/(public)/(marketing)/case-studies/layout'),
  compliance: await import('@/app/[locale]/(public)/(marketing)/compliance/page'),
  contact: await import('@/app/[locale]/(public)/(marketing)/contact/layout'),
  developers: await import('@/app/[locale]/(public)/(marketing)/developers/page'),
  enterprise: await import('@/app/[locale]/(public)/(marketing)/enterprise/page'),
  framework: await import('@/app/[locale]/(public)/(marketing)/framework/page'),
  mobile: await import('@/app/[locale]/(public)/(marketing)/mobile/page'),
  multiplayer: await import('@/app/[locale]/(public)/(marketing)/multiplayer/page'),
  pricing: await import('@/app/[locale]/(public)/(marketing)/pricing/layout'),
  security: await import('@/app/[locale]/(public)/(marketing)/security/page'),
  'self-hosted': await import('@/app/[locale]/(public)/(marketing)/self-hosted/page'),
  slack: await import('@/app/[locale]/(public)/(marketing)/slack/page'),
  sovereign: await import('@/app/[locale]/(public)/(marketing)/sovereign/page'),
  teams: await import('@/app/[locale]/(public)/(marketing)/teams/page'),
  'white-label': await import('@/app/[locale]/(public)/(marketing)/white-label/page'),
  services: await import('@/app/[locale]/(public)/(sales)/services/layout'),
  legal: await import('@/app/[locale]/(public)/(seo)/legal/layout'),
  download: await import('@/app/[locale]/(public)/download/page'),
} satisfies Record<string, { generateMetadata: () => Promise<unknown> }>;

describe('public marketing layouts resolve their route metadata', () => {
  for (const [name, mod] of Object.entries(modules)) {
    test(`${name} resolves its canonical URL, title and hreflang set`, async () => {
      const metadata = (await mod.generateMetadata()) as Record<string, unknown>;
      expect(metadata).toMatchSnapshot();
      const canonical = (metadata.alternates as { canonical?: unknown } | undefined)?.canonical;
      expect(String(canonical)).toMatch(/^https:\/\/kortix\.com(\/[a-z-]+)?/);
      const title =
        (metadata.title as { absolute?: string } | undefined)?.absolute ?? metadata.title;
      expect(title).toBeTruthy();
    });
  }
});
