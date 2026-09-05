'use client';

import { useBranding } from '@/features/branding/branding-provider';
import { cn } from '@/lib/utils';
import type { ComponentPropsWithoutRef } from 'react';

export type KortixLogoVariant = 'icon' | 'brandmark';

interface KortixLogoProps
  extends Omit<ComponentPropsWithoutRef<'svg'>, 'width' | 'height' | 'viewBox'> {
  /** Pixel height. The brandmark scales its width to match; the icon is square. */
  size?: number;
  /** `icon` = the Dosco symbol alone; `brandmark` = symbol + wordmark lockup. */
  variant?: KortixLogoVariant;
  className?: string;
}

/**
 * The canonical Dosco logo. Renders in `currentColor` so it follows the
 * surrounding text color (`text-foreground` in app surfaces).
 *
 * Organization branding: when the active account carries its own marks
 * (`useBranding()` — Enterprise `branding` entitlement), the matching slot
 * renders that image instead: `brandmark` → `logo_url` (falling back to
 * `icon_url` so a square-only brand still replaces the wordmark), `icon` →
 * `icon_url`. Same box, same `size` semantics, so no call site changes.
 * A dark-scheme variant (`*_dark_url`), when set, is rendered as a second
 * `<img>` toggled by the theme class (`dark:` — the app theme is class-based,
 * `next-themes attribute="class"`), so the swap is hydration-safe and needs
 * no JS. Outside the provider — and for every unbranded account — this is
 * Dosco, which renders in `currentColor` and needs no variant.
 *
 * `@/components/sidebar/kortix-logo` re-exports this under its legacy
 * `symbol`/`logomark` variant names — new code should import from here.
 */
export function KortixLogo({
  size = 24,
  variant = 'brandmark',
  className,
  style,
  ...props
}: KortixLogoProps) {
  const branding = useBranding();
  // Light is the base; dark is an optional override. A square-only brand
  // stands in for the wordmark, per scheme: a dark icon is a better dark
  // brandmark than a light logo.
  const lightSrc =
    variant === 'icon' ? branding?.icon_url : (branding?.logo_url ?? branding?.icon_url);
  const darkSrc =
    variant === 'icon'
      ? branding?.icon_dark_url
      : (branding?.logo_dark_url ?? branding?.icon_dark_url);

  if (lightSrc) {
    const alt = branding?.app_name ?? 'Home';
    const imgStyle =
      variant === 'icon'
        ? { width: `${size}px`, height: `${size}px`, ...style }
        : { height: `${size}px`, width: 'auto', maxWidth: `${size * 8}px`, ...style };
    const imgProps = props as ComponentPropsWithoutRef<'img'>;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={lightSrc}
          alt={alt}
          draggable={false}
          className={cn('shrink-0 select-none object-contain', darkSrc && 'dark:hidden', className)}
          style={imgStyle}
          {...imgProps}
        />
        {darkSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={darkSrc}
            alt={alt}
            draggable={false}
            className={cn('hidden shrink-0 select-none object-contain dark:block', className)}
            style={imgStyle}
            {...imgProps}
          />
        ) : null}
      </>
    );
  }

  // Dosco fallback art (stamped by dosco-brand patch-logo.py): upstream drew
  // the Kortix mark inline here. We render transparent Dosco PNGs instead,
  // swapped per color scheme exactly like the org-branding images above.
  const fallbackAlt = branding?.app_name ?? 'Dosco';

  if (variant === 'icon') {
    const imgStyle = { width: `${size}px`, height: `${size}px`, ...style };
    const imgProps = props as ComponentPropsWithoutRef<'img'>;
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/dosco-icon-dark.png"
          alt={fallbackAlt}
          draggable={false}
          className={cn('shrink-0 select-none object-contain dark:hidden', className)}
          style={imgStyle}
          {...imgProps}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/dosco-icon-light.png"
          alt={fallbackAlt}
          draggable={false}
          className={cn('hidden shrink-0 select-none object-contain dark:block', className)}
          style={imgStyle}
          {...imgProps}
        />
      </>
    );
  }

  const imgStyle = {
    height: `${size}px`,
    width: 'auto',
    maxWidth: `${size * 8}px`,
    ...style,
  };
  const imgProps = props as ComponentPropsWithoutRef<'img'>;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/dosco-wordmark-dark.png"
        alt={fallbackAlt}
        draggable={false}
        className={cn('shrink-0 select-none object-contain dark:hidden', className)}
        style={imgStyle}
        {...imgProps}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/dosco-wordmark-light.png"
        alt={fallbackAlt}
        draggable={false}
        className={cn('hidden shrink-0 select-none object-contain dark:block', className)}
        style={imgStyle}
        {...imgProps}
      />
    </>
  );
}
