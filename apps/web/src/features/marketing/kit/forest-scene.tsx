import { cn } from '@kortix/ui';

/**
 * Dosco Deep Forest: the dark architectural canopy behind the home hero and
 * the `/auth` showcase. Five layers only — two blueprint grids, the canopy
 * glow, the horizon mist and the framing vignette — so the surface never
 * depends on an image asset and stays dark in both themes.
 *
 * `visible` drives the hero's 500ms ramp from the theme canvas into the scene.
 * The auth panel mounts already visible.
 */
export function ForestScene({
  className,
  visible = true,
}: {
  className?: string;
  visible?: boolean;
}) {
  return (
    <div
      aria-hidden
      data-a11y-decorative
      className={cn(
        'dark bg-background pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-500 ease-out',
        visible ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      {/* Major architectural rule lines */}
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(to right, oklch(from var(--foreground) l c h / 0.05) 1px, transparent 1px), linear-gradient(to bottom, oklch(from var(--foreground) l c h / 0.05) 1px, transparent 1px)',
          backgroundSize: '144px 144px',
        }}
      />
      {/* Fine 36px blueprint subdivision */}
      <div
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            'linear-gradient(to right, oklch(from var(--foreground) l c h / 0.025) 1px, transparent 1px), linear-gradient(to bottom, oklch(from var(--foreground) l c h / 0.025) 1px, transparent 1px)',
          backgroundSize: '36px 36px',
        }}
      />
      {/* Volumetric forest canopy illumination */}
      <div
        className="absolute -top-1/4 left-1/2 h-[78vh] w-[115vw] -translate-x-1/2 rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(ellipse at 50% 42%, oklch(from var(--kortix-base) l c h / 0.42) 0%, oklch(from var(--kortix-base) calc(l * 0.65) c h / 0.24) 44%, transparent 76%)',
        }}
      />
      {/* Lower emerald horizon mist */}
      <div
        className="absolute -bottom-32 left-1/4 h-[42vh] w-[55vw] rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(circle, oklch(from var(--kortix-base) l c h / 0.16) 0%, oklch(from var(--kortix-base) l c h / 0.06) 50%, transparent 75%)',
        }}
      />
      {/* Subtle top & bottom framing vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to bottom, oklch(from var(--background) l c h / 0.6), transparent, oklch(from var(--background) l c h / 0.75))',
        }}
      />
    </div>
  );
}
