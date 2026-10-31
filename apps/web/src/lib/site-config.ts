export type NavSubLink = {
  href: string;
  name: string;
  description?: string;
  /** Absolute destination off kortix.com — opens in a new tab. */
  external?: boolean;
  /**
   * Icon slug rendered as a leading tile in the desktop dropdown. A string, not
   * a component: this module is imported by server code and the icon components
   * are client-only, so the slug→icon map lives in `product-menu.tsx`.
   */
  icon?: string;
};

export type NavMenuColumn = {
  title: string;
  links: NavSubLink[];
};

/**
 * A menu is its links and nothing else. Both menus previously carried a promo
 * strip along the bottom; it added a row of chrome to every hover without
 * adding a destination, so the shape no longer has one.
 */
export type NavMenu = {
  columns: NavMenuColumn[];
};

export type NavLink =
  | { id: number; name: string; href: string }
  | { id: number; name: string; href: NavSubLink[] }
  | { id: number; name: string; menu: NavMenu };

import { CANONICAL_ORIGIN } from '@kortix/ui/internal/lib/site-metadata';

export const productMenu: NavMenu = {
  columns: [
    {
      title: 'Platform',
      links: [
        {
          name: 'Self-hosted',
          href: '/self-hosted',
          // ACCURACY: never "air-gapped" — `self-host start` pulls images from
          // docker.io, so a fully disconnected install is not shipped.
          description: 'Your own VPC or your own on-prem network',
          icon: 'hard-drives',
        },
        {
          name: 'Security',
          href: '/security',
          description: 'Isolation, credentials, permissions and audit',
          icon: 'shield',
        },
        {
          name: 'Enterprise',
          href: '/enterprise',
          description: 'SSO, RBAC, audit trails and approval gates',
          icon: 'buildings',
        },
      ],
    },
  ],
};

export const siteConfig = {
  url: CANONICAL_ORIGIN,
  nav: {
    links: [
      { id: 1, name: 'Product', menu: productMenu },
      // Solutions is deliberately NOT in the top bar. Eight role pages is a
      // wide menu beside Product; the roles live in the footer, and the
      // home-page use-case cards are the in-page entry point.
      { id: 4, name: 'Pricing', href: '/pricing' },
    ] as NavLink[],
  },
  hero: {
    description:
      "Dosco is the agentic operating system — agents, skills, memory and connectors in one managed workspace, and the software foundation for AltMatter's intelligent hardware.",
  },
  footerLinks: [
    {
      title: 'Product',
      links: [
        { id: 5, title: 'Contact', url: 'mailto:support@dosco.live' },
      ],
    },
    {
      title: 'Resources',
      links: [
        { id: 7, title: 'Documentation', url: '/docs' },
        { id: 8, title: 'Discord', url: 'https://discord.com/invite/RvFhXUdZ9H' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { id: 10, title: 'Privacy Policy', url: '/legal?tab=privacy' },
        { id: 11, title: 'Terms of Service', url: '/legal/terms' },
      ],
    },
  ],
};

export type SiteConfig = typeof siteConfig;
