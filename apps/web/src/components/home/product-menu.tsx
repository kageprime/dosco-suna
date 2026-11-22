'use client';

import Link from '@/components/site-link';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { cn } from '@kortix/ui';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { type KeyboardEvent, type Ref } from 'react';

export type MegaMenuLink = { label: string; href: string; external?: boolean };

/** One column of the panel: a muted heading over a plain list of links. */
export type MegaMenuGroup = { title: string; links: MegaMenuLink[] };

export type MegaMenu = {
  id: 'product' | 'resources';
  label: string;
  groups: MegaMenuGroup[];
};

/**
 * The three menus of the bar. Every href is a live route. Plain English,
 * localized through the site-config catalog wherever the same words already
 * have a key.
 */
export const MEGA_MENUS: MegaMenu[] = [
  {
    id: 'product',
    label: 'Product',
    groups: [
      {
        title: 'The CompanyOS',
        links: [
          { label: 'Multiplayer AI', href: '/multiplayer' },
          { label: 'Company as code', href: '/framework' },
          { label: 'Sovereign and open', href: '/sovereign' },
          { label: 'Outcomes, 24/7', href: '/#use-cases' },
        ],
      },
      {
        title: 'Use it from',
        links: [
          { label: 'Desktop', href: '/desktop' },
          { label: 'Mobile', href: '/mobile' },
          { label: 'Slack', href: '/slack' },
          { label: 'Microsoft Teams', href: '/teams' },
        ],
      },
      {
        title: 'Run it',
        links: [
          { label: 'Security', href: '/security' },
          { label: 'Enterprise', href: '/enterprise' },
          { label: 'Compliance', href: '/compliance' },
          { label: 'Pricing', href: '/pricing' },
        ],
      },
    ],
  },
  {
    id: 'resources',
    label: 'Resources',
    groups: [
      {
        title: 'Learn',
        links: [
          { label: 'Use cases', href: '/use-cases' },
          { label: 'Case studies', href: '/case-studies' },
          ...(process.env.NEXT_PUBLIC_BLOG_ORIGIN ? [{ label: 'Blog', href: '/blog' }] : []),
        ],
      },
      {
        title: 'Get Dosco',
        links: [
          { label: 'Download', href: '/download' },
        ],
      },
      {
        title: 'Company',
        links: [
          { label: 'Services', href: '/services' },
          { label: 'Legal', href: '/legal/terms' },
        ],
      },
    ],
  },
];

type MegaMenuPanelProps = {
  menu: MegaMenu;
  open: boolean;
  ref?: Ref<HTMLDivElement>;
  /** A link was chosen: the menu closes. */
  onNavigate: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The repo's star count, already formatted (the bar's own fetch); null hides it. */
  stars?: string | null;
};

/**
 * Feature tile in the Resources panel's fourth column.
 */
function PlatformCard({ onNavigate }: { onNavigate: () => void }) {
  return (
    <Link
      href="/marketplace"
      onClick={onNavigate}
      className="group/platform bg-foreground text-background outline-ring flex flex-col justify-between gap-8 rounded-lg p-5 focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <span className="flex flex-col">
        <span className="text-lg font-medium">Marketplace</span>
        <span className="text-background/80 mt-1 text-sm">
          Discover skills, plugins, and tools to power your workspace.
        </span>
      </span>
      <span className="group-hover/platform:text-ring inline-flex items-center gap-1.5 text-sm transition-colors duration-moderate">
        Explore Marketplace
        <ArrowUpRightIcon className="size-3.5 opacity-0 transition-opacity duration-moderate group-hover/platform:opacity-100 group-focus-visible/platform:opacity-100" />
      </span>
    </Link>
  );
}

/**
 * One full-width panel: up to four columns, each a muted group heading over
 * a plain list of links. An external link carries a small up-right arrow.
 * Every panel sits in one grid cell, so switching menus cross-fades in place;
 * each keeps its own height (`self-start`) and draws its own bottom rule. A
 * closed panel is inert.
 */
export function MegaMenuPanel({ menu, open, ref, onNavigate, onKeyDown, stars }: MegaMenuPanelProps) {
  return (
    <div
      ref={ref}
      id={`mega-${menu.id}`}
      inert={!open}
      onKeyDown={onKeyDown}
      className={cn(
        'col-start-1 row-start-1 self-start border-b transition-[opacity,visibility] duration-normal ease-out',
        open ? 'opacity-100' : 'invisible opacity-0',
      )}
    >
      <div className={cn(MARKETING_CONTAINER, 'grid grid-cols-4 gap-8 pt-8 pb-12')}>
        {menu.groups.map((group) => (
          <div key={group.title}>
            <p className="text-muted-foreground text-sm">{group.title}</p>
            {/* Each link fills its column and carries the row gap as padding,
                so the whole row is the target and the rows touch: no dead
                strip between two links, and the hover tint shows anywhere on
                the row. Same spacing as before (gap-3 = 2 × py-1.5). */}
            <ul className="mt-2.5 flex flex-col">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={onNavigate}
                    {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    className="text-foreground hover:text-ring outline-ring flex w-full items-center gap-1.5 rounded-sm py-1.5 text-base transition-colors duration-moderate focus-visible:outline-2"
                  >
                    {link.label}
                    {link.external && <ArrowUpRightIcon className="size-3.5" />}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {menu.id === 'resources' && <PlatformCard onNavigate={onNavigate} />}
      </div>
    </div>
  );
}
