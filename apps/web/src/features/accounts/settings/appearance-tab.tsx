'use client';

/**
 * `WallpaperCard` — the wallpaper-picker tile. This file used to also export
 * a full `AppearanceTab` (theme switch + wallpaper grid + session-panel mode
 * + layout toggle) that backed the legacy user-settings modal.
 * Task 10 deleted that modal; `AppearanceTab` lost its only consumer and was
 * removed with it. This file survives — unlike `security-tab.tsx`, which
 * Task 10 also deleted — because `WallpaperCard` still has a real, live
 * consumer: `features/workspace/settings/tabs/preferences-tab.tsx`. Moving
 * it there instead was considered and rejected: nothing else needs this file
 * to be gone, and `preferences-tab.tsx` already imports it from this exact
 * path, so relocating it would be pure churn for this task. It's a natural
 * candidate for Phase 3 ("deleting `/accounts/**`") to fold directly into
 * `preferences-tab.tsx` when that phase removes this directory wholesale.
 */

import { Badge } from '@kortix/ui/badge';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { cn } from '@kortix/ui';
import { DEFAULT_WALLPAPER_ID, type Wallpaper } from '@kortix/ui/theme';
import { CheckCircleIcon as CheckCircleSolid } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** Exported so `features/workspace/settings/tabs/preferences-tab.tsx` can reuse
 *  this card instead of re-implementing the wallpaper picker — see that
 *  file's header for why this tab still imports pieces of this one rather
 *  than duplicating them. */
export function WallpaperCard({
  wallpaper,
  thumbSrc,
  thumb,
  isActive,
  onSelect,
  defaultLabel = 'Default',
}: {
  wallpaper: Wallpaper;
  /** Pre-rendered preview image — shader wallpapers never run a live canvas in the picker */
  thumbSrc?: string;
  /** A still drawn on the client, for wallpapers with no image file. */
  thumb?: ReactNode;
  isActive: boolean;
  onSelect: () => void;
  defaultLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group relative w-full cursor-pointer rounded-md text-left"
    >
      <div
        className={cn(
          'bg-background duration-moderate relative isolate aspect-video w-full overflow-hidden rounded-md border transition-colors',
          isActive ? 'border-primary/40' : 'border-border group-hover:border-border/80',
        )}
      >
        <div className="absolute inset-0" aria-hidden="true">
          {thumb ? (
            thumb
          ) : thumbSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-cover select-none"
              loading="lazy"
              draggable={false}
            />
          ) : (
            <WallpaperBackground wallpaperId={wallpaper.id} preview />
          )}
        </div>

        <div
          className={cn(
            'duration-moderate pointer-events-none absolute inset-0 transition-colors',
            isActive ? 'bg-transparent' : 'group-hover:bg-foreground/[0.06] bg-transparent',
          )}
        />
      </div>
      {/* The check sits in the caption, not on the thumbnail: the thumbnail's
          top corners hold the card actions. */}
      <div className="flex items-center justify-between gap-2 px-1.5 py-1">
        <span className="text-foreground flex min-w-0 items-center gap-1 text-xs font-medium">
          {wallpaper.name}
          {wallpaper.id === DEFAULT_WALLPAPER_ID && (
            <Badge size="sm" variant="secondary">
              {defaultLabel}
            </Badge>
          )}
        </span>
        {isActive && <CheckCircleSolid weight="fill" className="size-4 shrink-0" />}
      </div>
    </button>
  );
}
