'use client';

import { EnvelopeSimpleIcon, MonitorIcon, PlugIcon } from '@phosphor-icons/react';
import { useState, type ComponentType } from 'react';

import { Discord } from '../icons/discord';
import { MicrosoftTeams } from '../icons/microsoft-teams';
import { Slack } from '../icons/slack';
import { Telegram } from '../icons/telegram';
import { cn } from '../lib/utils';
import {
  resolveConnectorLogo,
  type ConnectorLogoSource,
  type NativeConnectorApp,
} from './connector-logo-source';

export type { ConnectorLogoSource } from './connector-logo-source';

const TILE = {
  xs: 'size-5 rounded-sm',
  sm: 'size-6 rounded-sm',
  md: 'size-8 rounded-md',
  lg: 'size-9 rounded-md',
  xl: 'size-14 rounded-xl',
} as const;

const MARK = { xs: 'size-3', sm: 'size-3.5', md: 'size-4', lg: 'size-5', xl: 'size-7' } as const;

/**
 * Dark theme only: a catalogue logo sits on an always-light tile (the same
 * rule as `LOGO_TILE_BACKGROUND`), so a near-black transparent mark (GitHub,
 * Brandfetch) keeps its contrast. The inset lives inside the tile, so a
 * full-bleed square logo fills it edge to edge with no second frame.
 */
const DARK_LOGO_TILE = 'dark:bg-white';
const DARK_LOGO_INSET = { xs: 'dark:p-px', sm: 'dark:p-0.5', md: 'dark:p-0.5', lg: 'dark:p-1', xl: 'dark:p-1.5' } as const;

export type ConnectorLogoSize = keyof typeof TILE;

/**
 * The marks of the Kortix-built connectors, as their channel banners draw
 * them; brand marks keep their colours. `apps/web/public/connector-icons/<app>.svg`
 * is this mark rendered on its tile (`connector-mark-files.tsx`), so the URL
 * the API catalogue sends and this component are one image.
 */
export const NATIVE_MARK: Record<NativeConnectorApp, { Mark: ComponentType<{ className?: string }>; brand: boolean }> = {
  slack: { Mark: Slack, brand: true },
  teams: { Mark: MicrosoftTeams, brand: true },
  telegram: { Mark: Telegram, brand: true },
  discord: { Mark: Discord, brand: true },
  email: { Mark: EnvelopeSimpleIcon, brand: false },
  computer: { Mark: MonitorIcon, brand: false },
};

/** The tile a mark sits on: the channel banner's (background, hairline border). */
function MarkTile({
  size,
  className,
  children,
}: {
  size: ConnectorLogoSize;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn('bg-background flex shrink-0 items-center justify-center border', TILE[size], className)}
    >
      {children}
    </span>
  );
}

/**
 * A connector's logo — the only one. Every connector, app and account surface
 * renders this, so the same app shows the same mark everywhere
 * (`connector-logo-source.ts` holds the rule).
 *
 * Kortix-built connectors and connectors with no logo draw a mark on the
 * banner tile. A catalogue logo is the bare image in the light theme: its own
 * shape is the edge. In the dark theme it sits on a light tile (`DARK_LOGO_TILE`).
 * A URL that fails to load latches per URL (a swapped URL gets a fresh try)
 * and shows the neutral fallback, so "missing" and "broken" look identical.
 */
export function ConnectorLogo({
  source,
  size = 'lg',
  className,
}: {
  source: ConnectorLogoSource;
  size?: ConnectorLogoSize;
  className?: string;
}) {
  const logo = resolveConnectorLogo(source);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (logo.kind === 'native') {
    const { Mark, brand } = NATIVE_MARK[logo.app];
    return (
      <MarkTile size={size} className={className}>
        <Mark className={cn('shrink-0', MARK[size], !brand && 'text-muted-foreground')} />
      </MarkTile>
    );
  }
  if (logo.kind === 'none' || failedUrl === logo.src) {
    return (
      <MarkTile size={size} className={className}>
        <PlugIcon className={cn('text-muted-foreground shrink-0', MARK[size])} />
      </MarkTile>
    );
  }
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center overflow-hidden', TILE[size], DARK_LOGO_TILE, className)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- third-party logos on arbitrary hosts; the Next loader adds nothing */}
      <img
        src={logo.src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        className={cn('size-full object-contain select-none', TILE[size], DARK_LOGO_INSET[size])}
        onError={() => setFailedUrl(logo.src)}
      />
    </span>
  );
}
