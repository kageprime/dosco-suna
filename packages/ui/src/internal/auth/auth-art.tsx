'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { lazyClient } from '../../lib/lazy-client';
import { ShaderSafe, supportsWebGL2 } from '../../primitives/shader-safe';
import { cn } from '../lib/utils';

/** Tailwind's `lg`: the breakpoint at which the frame shows the pane. */
const WIDE = '(min-width: 64rem)';

/** One ring: a 160px circle grown from a quarter of its size while it fades. */
const RING_SIZE = 160;
const RING_MS = 600;
const RING_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
/** Pointer travel between two rings on a drag. */
const RING_STEP = 48;
/** Rings alive at once. A fast drag drops rings instead of stacking layers. */
const RING_CAP = 6;

const Dithering = lazyClient(() => import('@paper-design/shaders-react').then((m) => m.Dithering));

/**
 * A theme token as an `rgb()` string. The shader parses hex and rgb only, and
 * the tokens are oklch: a 1px 2D canvas resolves the token the same way the
 * page paints it.
 */
function resolveToken(scope: Element, name: string): [number, number, number] | null {
  const value = getComputedStyle(scope).getPropertyValue(name).trim();
  const probe = document.createElement('canvas').getContext('2d');
  if (!value || !probe) return null;
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** `a` moved `t` of the way to `b`, as an `rgb()` string. */
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const [r, g, bl] = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * The art half of the auth frame: a slow dither field, inset from the top,
 * right and bottom edges. An art pane is dark in both themes (brand D4d,
 * graphic-elements.md): the `dark` class scopes its tokens, so the solid dark
 * surface is also the fallback that paints before WebGL and without WebGL2.
 * Decorative only. A press or a drag on the pane sends out blue rings.
 * Reduced motion freezes the field and drops the rings.
 */
export function AuthArt({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion() ?? false;
  const pane = useRef<HTMLDivElement>(null);
  const rings = useRef<HTMLDivElement>(null);
  // The last ring of the current drag; null when no pointer is down.
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Rings never touch React state: each is a node with one WAAPI animation of
  // `transform` and `opacity`, which the compositor runs off the main thread.
  const ring = (x: number, y: number) => {
    const layer = rings.current;
    if (!layer || layer.childElementCount >= RING_CAP) return;
    const node = document.createElement('span');
    node.className = 'border-kortix-blue absolute top-0 left-0 rounded-full border-2';
    node.style.width = node.style.height = `${RING_SIZE}px`;
    layer.appendChild(node);
    const at = `translate(${x - RING_SIZE / 2}px, ${y - RING_SIZE / 2}px)`;
    node
      .animate(
        [
          { transform: `${at} scale(0.25)`, opacity: 1 },
          { transform: `${at} scale(1)`, opacity: 0 },
        ],
        { duration: RING_MS, easing: RING_EASE, fill: 'forwards' },
      )
      .finished.catch(() => {})
      .finally(() => node.remove());
  };

  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const [colors, setColors] = useState<{ back: string; front: string } | null>(null);

  // Effect-only, so a render without a DOM never reads it. The pane's own
  // `dark` scope fixes the tokens, so a theme flip changes nothing here.
  useEffect(() => {
    if (!pane.current || !supportsWebGL2()) return;
    const back = resolveToken(pane.current, '--muted');
    const ink = resolveToken(pane.current, '--muted-foreground');
    // The ink sits part of the way to the surface: texture, not a picture
    // that competes with the form.
    if (!back || !ink) return;
    const resolved = { back: `rgb(${back.join(', ')})`, front: mix(back, ink, 0.4) };
    // The pane is `display: none` below `lg`, but a mounted shader still
    // loads and runs its frame loop: mount it only while the pane shows.
    const wide = window.matchMedia(WIDE);
    const sync = () => setColors(wide.matches ? resolved : null);
    sync();
    wide.addEventListener('change', sync);
    return () => wide.removeEventListener('change', sync);
  }, []);

  return (
    <div aria-hidden className={cn('p-3 pl-0', className)}>
      <div
        ref={pane}
        className="dark bg-muted relative size-full touch-none overflow-hidden rounded-md select-none"
        onPointerDown={(event) => {
          if (reduceMotion || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = point(event);
          ring(drag.current.x, drag.current.y);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const next = point(event);
          if (Math.hypot(next.x - drag.current.x, next.y - drag.current.y) < RING_STEP) return;
          drag.current = next;
          ring(next.x, next.y);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {colors ? (
          <ShaderSafe>
            <Dithering
              colorBack={colors.back}
              colorFront={colors.front}
              shape="warp"
              type="4x4"
              size={2}
              scale={0.6}
              speed={reduceMotion ? 0 : 0.15}
              // The pane's clip does not reach a WebGL canvas: round it too.
              className="rounded-md"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            />
          </ShaderSafe>
        ) : null}
        <div ref={rings} className="pointer-events-none absolute inset-0" />
      </div>
    </div>
  );
}
