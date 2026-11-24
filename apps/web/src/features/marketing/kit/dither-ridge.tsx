'use client';

import { cn } from '@kortix/ui';
import { useEffect, useRef } from 'react';

/** One dot per 2 CSS px, drawn at deviceScale 1 and upscaled with `pixelated`. */
const DOT = 2;

/** Bayer 8x8 ordered thresholds, 0..1. The field is a threshold map, not noise. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
  54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
].map((step) => (step + 0.5) / 64);

/** Dot density per depth band, from the ridge line down to the page edge. */
const STRATA = [1, 0.74, 0.54, 0.4, 0.28, 0.19, 0.12];

/** How much of the field above the ridge keeps a light dusting. */
const SPRAY = 0.06;
const SPRAY_HEIGHT = 0.3;

/**
 * The skyline of a dithered print: a ridge drawn as ordered dots in one ink,
 * banded by depth so the shape reads as a landscape rather than noise. The
 * bands follow the ridge, so the strata contour like a topographic map.
 */
function ridge(x: number): number {
  return (
    0.54 +
    0.13 * Math.sin(x * 6.1 + 0.6) +
    0.055 * Math.sin(x * 15.7 + 2.2) +
    0.028 * Math.sin(x * 37.3 + 4.1) +
    0.014 * Math.sin(x * 91.7 + 1.3)
  );
}

/** The canvas's `color` (a theme token) as 0-255 RGB channels, via a 1px 2D
 *  canvas, so an oklch() token resolves the same way the page paints it. The
 *  `ImageData` buffer takes 0-255, so the probe's bytes pass straight through. */
function readInk(canvas: HTMLCanvasElement): [number, number, number] {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [128, 128, 128];
  probe.fillStyle = getComputedStyle(canvas).color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

/**
 * The field at the bottom of the landing, after the loopmaxxing footer: a
 * dithered ridge revealed as the page scrolls over it. It is static art; the
 * parent decides where it sits and how it sticks. The theme accent is the only
 * ink, so it stays inside the brand's one-accent rule, and it re-reads that ink
 * when the theme class changes.
 */
export function DitherRidge({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const paint = () => {
      const width = Math.max(1, Math.round(canvas.clientWidth / DOT));
      const height = Math.max(1, Math.round(canvas.clientHeight / DOT));
      canvas.width = width;
      canvas.height = height;
      const [r, g, b] = readInk(canvas);
      const image = context.createImageData(width, height);
      for (let y = 0; y < height; y++) {
        const py = y / height;
        for (let x = 0; x < width; x++) {
          const threshold = BAYER[((y & 7) << 3) | (x & 7)]!;
          const horizon = ridge(x / width);
          const index = (y * width + x) * 4;
          if (py < horizon) {
            // A dusting above the ridge, thinning with distance from the line.
            const reach = 1 - Math.min(1, (horizon - py) / SPRAY_HEIGHT);
            if (threshold >= SPRAY * reach * reach) continue;
            image.data[index] = r;
            image.data[index + 1] = g;
            image.data[index + 2] = b;
            image.data[index + 3] = 255 * 0.35;
            continue;
          }
          const depth = (py - horizon) / Math.max(0.001, 1 - horizon);
          const band = Math.min(STRATA.length - 1, Math.floor(depth * STRATA.length));
          const density = STRATA[band]!;
          if (threshold >= density) continue;
          image.data[index] = r;
          image.data[index + 1] = g;
          image.data[index + 2] = b;
          image.data[index + 3] = Math.round(255 * Math.min(1, density + 0.18));
        }
      }
      context.putImageData(image, 0, 0);
    };

    paint();
    const resizeObserver = new ResizeObserver(paint);
    resizeObserver.observe(canvas);
    // The theme flips a class on <html>: re-read the ink when it does.
    const themeObserver = new MutationObserver(paint);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return <canvas ref={ref} aria-hidden className={cn('text-kortix-base block size-full [image-rendering:pixelated]', className)} />;
}
