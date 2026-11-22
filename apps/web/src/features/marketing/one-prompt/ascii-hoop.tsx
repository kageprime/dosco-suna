'use client';

import { cn } from '@kortix/ui';
import { useEffect, useRef } from 'react';

import { HOOP_PALETTE, hoopColorAt } from './hoop-palette';

/**
 * The hula hoop drawn the way the classic ASCII spinning donut (donut.c) draws
 * a torus: points on a tube, a 1/z depth buffer, and light that picks a glyph
 * from a ramp. Every cell takes the color of the hoop segment it belongs to and
 * the segments travel as it turns; the color is never dimmed, because a dimmed
 * hoop color turns muddy. Three shapes:
 *
 * - `infinity`: one tube along a lemniscate (∞) that passes over itself.
 * - `linked`: two hoops interlocked like chain links, rolling round the line
 *   through their centres, so each passes in front of and behind the other.
 * - `ring`: one hoop, an O of the wordmark.
 *
 * As letters, the canvas covers the ink box of the font's real "O"s (measured
 * with `measureText` in the computed font, overshoot included), and the
 * silhouette at its widest pose fills it. Below PIXEL_BELOW px glyphs are
 * unreadable, so cells are filled squares, like the grain. One ticker drives
 * every instance; an instance draws only while on screen; a hidden tab gets
 * no frames; reduced motion draws one still frame.
 */

export type HoopShape = 'infinity' | 'linked' | 'ring';

/** From least to most light. */
const RAMP = '.,-~:;=!*#$@';
/** How far the shape sits from the eye. */
const DISTANCE = 7;
/** The canvas height under which cells are pixels, not glyphs. */
const PIXEL_BELOW = 40;
/** Rows come from the canvas height, never a fixed character size. */
const GLYPH_ROW_PX = 6.5;
const PIXEL_ROW_PX = 1.5;
const FRAME_MS = 1000 / 30;
/** Light from the top left, toward the shape. */
const LIGHT = normalize([-1, 1.4, -1]);
/** A ring's radius. */
const RING = 2;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function normalize([x, y, z]: number[]): [number, number, number] {
  const length = Math.hypot(x!, y!, z!) || 1;
  return [x! / length, y! / length, z! / length];
}

const still = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The page's one ticker: 30 frames a second to every instance on screen, nothing while none is. */
const drawers = new Set<(seconds: number) => void>();
let tickerFrame = 0;
let last = 0;
function tick(now: number) {
  tickerFrame = requestAnimationFrame(tick);
  if (now - last < FRAME_MS) return;
  last = now;
  for (const draw of drawers) draw(now / 1000);
}
function subscribe(draw: (seconds: number) => void) {
  drawers.add(draw);
  if (drawers.size === 1) tickerFrame = requestAnimationFrame(tick);
  return () => {
    drawers.delete(draw);
    if (drawers.size === 0) cancelAnimationFrame(tickerFrame);
  };
}

export interface AsciiHoopProps {
  className?: string;
  shape?: HoopShape;
  /** `ring` only: radians from lying flat toward the reader. Near π/2 is an O facing you. */
  tilt?: number;
  /** How far the pose sways either way, in radians. */
  sway?: number;
  /** The tube's radius, against a ring's radius of 2 or the curve's half-width of 2.4. */
  tube?: number;
  /** Where the segments start, as a share of the curve: two hoops side by side differ. */
  phase?: number;
  /** 1 turns one way, -1 the other. */
  direction?: 1 | -1;
  /** Fit the canvas to the ink box of this many "O" letters of the parent's font. Without it, the canvas fills its parent. */
  letters?: number;
}

type Emit = (x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number) => void;
type Pose = Required<Pick<AsciiHoopProps, 'shape' | 'tilt' | 'sway' | 'tube' | 'phase' | 'direction'>>;

/** Rotations round x (a), then y (b), then z (c), applied to a point and its normal. */
function turn(a: number, b: number, c: number, emit: Emit): Emit {
  const [sa, ca, sb, cb, sc, cc] = [Math.sin(a), Math.cos(a), Math.sin(b), Math.cos(b), Math.sin(c), Math.cos(c)];
  const rotate = (x: number, y: number, z: number): [number, number, number] => {
    [y, z] = [y * ca - z * sa, y * sa + z * ca];
    [x, z] = [x * cb + z * sb, -x * sb + z * cb];
    [x, y] = [x * cc - y * sc, x * sc + y * cc];
    return [x, y, z];
  };
  return (x, y, z, nx, ny, nz, color) => {
    const [px, py, pz] = rotate(x, y, z);
    const [qx, qy, qz] = rotate(nx, ny, nz);
    emit(px, py, pz, qx, qy, qz, color);
  };
}

/** A ring of radius RING round the y axis, centred at (cx, 0, 0), its colors starting at `phase`. */
function ring(cx: number, tube: number, phase: number, ringStep: number, tubeStep: number, emit: Emit) {
  for (let around = 0; around < Math.PI * 2; around += ringStep) {
    const [sinA, cosA] = [Math.sin(around), Math.cos(around)];
    const color = hoopColorAt(around / (Math.PI * 2) + phase);
    for (let section = 0; section < Math.PI * 2; section += tubeStep) {
      const [sinS, cosS] = [Math.sin(section), Math.cos(section)];
      const reach = RING + tube * cosS;
      emit(cx + reach * cosA, tube * sinS, reach * sinA, cosS * cosA, sinS, cosS * sinA, color);
    }
  }
}

/** A lemniscate (∞) in the x-y plane, its two passes through the centre apart in depth. */
function lemniscate(t: number): [number, number, number] {
  const d = 1 + Math.sin(t) ** 2;
  return [(2.4 * Math.cos(t)) / d, (2.4 * Math.sin(t) * Math.cos(t)) / d, 0.55 * Math.sin(t)];
}

/** Every lit point of the shape at a moment: its position, its normal and its palette index. */
function shapePoints(pose: Pose, seconds: number, step: number, tubeStep: number, emit: Emit) {
  const { shape, tilt, sway, tube, phase, direction } = pose;
  const swing = Math.sin(seconds * 1.3);
  if (shape === 'ring') {
    // Spin round the hoop's own axis, then lean toward the reader with a sway and a roll: the hoop on a hip.
    const posed = turn(tilt + sway * swing, 0, sway * 0.6 * Math.sin(seconds * 0.9), emit);
    ring(0, tube, phase, step, tubeStep, turn(0, direction * seconds * 0.9, 0, posed));
    return;
  }
  if (shape === 'linked') {
    // Two rings through each other's centres, one standing, one lying; the pair rolls round the x axis.
    const posed = turn(direction * seconds * 0.7, sway * swing, 0, emit);
    const standing: Emit = (x, y, z, nx, ny, nz, color) => posed(x, -z, y, nx, -nz, ny, color);
    ring(-1, tube, phase - seconds * 0.15, step, tubeStep, standing);
    ring(1, tube, phase + 0.5 + seconds * 0.15, step, tubeStep, posed);
    return;
  }
  // The infinity: a tube swept along the curve; the colors travel along it.
  const posed = turn(0.25 * swing, sway * 2 * Math.sin(seconds * 0.8), 0, emit);
  const travel = direction * seconds * 0.12;
  for (let t = 0; t < Math.PI * 2; t += step) {
    const [cx, cy, cz] = lemniscate(t);
    const [ax, ay, az] = lemniscate(t + 0.001);
    const tangent = normalize([ax - cx, ay - cy, az - cz]);
    // A frame round the tangent: n lies in the curve's plane, b completes it.
    const n = normalize([-tangent[1], tangent[0], 0]);
    const b: [number, number, number] = [
      tangent[1] * n[2] - tangent[2] * n[1],
      tangent[2] * n[0] - tangent[0] * n[2],
      tangent[0] * n[1] - tangent[1] * n[0],
    ];
    const color = hoopColorAt(t / (Math.PI * 2) + phase + travel);
    for (let section = 0; section < Math.PI * 2; section += tubeStep) {
      const [s, c] = [Math.sin(section), Math.cos(section)];
      const nx = c * n[0] + s * b[0];
      const ny = c * n[1] + s * b[1];
      const nz = c * n[2] + s * b[2];
      posed(cx + tube * nx, cy + tube * ny, cz + tube * nz, nx, ny, nz, color);
    }
  }
}

/** The shape's projected half-width and half-height at unit scale, over every pose it reaches. */
function bounds(pose: Pose): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let seconds = 0; seconds < 30; seconds += 0.25) {
    shapePoints(pose, seconds, Math.PI / 60, Math.PI / 5, (px, py, pz) => {
      const near = 1 / (pz + DISTANCE);
      x = Math.max(x, Math.abs(px * near));
      y = Math.max(y, Math.abs(py * near));
    });
  }
  return { x, y };
}

/**
 * The element's layout size, before any transform: an opening animation that
 * scales the page must not shrink the hoop, and a transform fires no resize.
 */
function layoutSize(element: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(element);
  return { width: parseFloat(style.width) || 0, height: parseFloat(style.height) || 0 };
}

/**
 * The ink box of `letters` "O"s in the element's own font, relative to the
 * element's box (one advance per letter wide, sitting on the baseline).
 */
function inkBox(holder: HTMLElement, letters: number) {
  const style = getComputedStyle(holder);
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const o = probe.measureText('O');
  const box = layoutSize(holder);
  // The last O starts one advance before the slot's end: the slot's width minus one advance.
  const rest = letters > 1 ? box.width - o.width : 0;
  // The slot's bottom is the baseline: the O's ink rises its ascent above it and overshoots its descent below.
  return {
    left: -o.actualBoundingBoxLeft,
    width: o.actualBoundingBoxLeft + o.actualBoundingBoxRight + rest,
    top: box.height - o.actualBoundingBoxAscent,
    height: o.actualBoundingBoxAscent + o.actualBoundingBoxDescent,
  };
}

export function AsciiHoop({
  className,
  shape = 'infinity',
  tilt = Math.PI / 2 - 0.3,
  sway = 0.12,
  tube = 0.3,
  phase = 0,
  direction = 1,
  letters,
}: AsciiHoopProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext('2d');
    const holder = node?.parentElement;
    if (!node || !context || !holder) return;
    const pose: Pose = { shape, tilt, sway, tube, phase, direction };
    const extent = bounds(pose);
    let width = 0;
    let height = 0;
    let columns = 0;
    let rows = 0;
    let cellWidth = 0;
    let cellHeight = 0;
    let left = 0;
    let pixel = false;
    // The canvas sits absolutely in its parent and never sizes the layout. As a letter it covers the O's ink box.
    const size = () => {
      const ink = letters ? inkBox(holder, letters) : null;
      const box = layoutSize(holder);
      if (ink) Object.assign(node.style, { left: `${ink.left}px`, top: `${ink.top}px`, width: `${ink.width}px`, height: `${ink.height}px` });
      else Object.assign(node.style, { left: '0px', top: '0px', width: '100%', height: '100%' });
      const ratio = window.devicePixelRatio || 1;
      width = ink ? ink.width : box.width;
      height = ink ? ink.height : box.height;
      pixel = height < PIXEL_BELOW;
      rows = pixel ? clamp(Math.round(height / PIXEL_ROW_PX), 6, 16) : clamp(Math.round(height / GLYPH_ROW_PX), 8, 72);
      cellHeight = height / rows;
      cellWidth = pixel ? cellHeight : cellHeight / 2;
      columns = Math.max(4, Math.floor(width / cellWidth));
      left = (width - columns * cellWidth) / 2;
      node.width = Math.max(1, Math.round(width * ratio));
      node.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.font = `bold ${(cellHeight * 1.05).toFixed(2)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
    };

    const draw = (seconds: number) => {
      if (!width || !height) return;
      const count = columns * rows;
      const glyph = new Int8Array(count).fill(-1);
      const color = new Int8Array(count);
      const depth = new Float32Array(count);
      // Each axis has its own scale from the measured bounds: the silhouette fills the canvas both ways.
      const scaleX = columns / 2 / extent.x;
      const scaleY = rows / 2 / extent.y;
      const step = Math.max(0.01, (Math.PI * 2) / (Math.max(columns, rows) * 8));
      const tubeStep = pixel ? 0.4 : 0.07;
      shapePoints(pose, seconds, step, tubeStep, (x, y, z, nx, ny, nz, segment) => {
        const near = 1 / (z + DISTANCE);
        const column = Math.round(columns / 2 + scaleX * near * x - 0.5);
        const row = Math.round(rows / 2 - scaleY * near * y - 0.5);
        if (column < 0 || column >= columns || row < 0 || row >= rows) return;
        const at = row * columns + column;
        if (near <= depth[at]!) return;
        depth[at] = near;
        const light = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
        glyph[at] = clamp(Math.floor(((light + 1) / 2) * RAMP.length), 0, RAMP.length - 1);
        color[at] = segment;
      });
      context.clearRect(0, 0, width, height);
      for (let at = 0; at < count; at += 1) {
        if (glyph[at]! < 0) continue;
        context.fillStyle = HOOP_PALETTE[color[at]!]!;
        const x = left + (at % columns) * cellWidth;
        const y = Math.floor(at / columns) * cellHeight;
        if (pixel) context.fillRect(x, y, cellWidth, cellHeight);
        else context.fillText(RAMP[glyph[at]!]!, x + cellWidth / 2, y + cellHeight / 2);
      }
    };

    const redraw = () => {
      size();
      draw(performance.now() / 1000);
    };
    redraw();
    // The font may load after the first frame: measure again once it has.
    void document.fonts?.ready.then(redraw);
    const resize = new ResizeObserver(redraw);
    resize.observe(holder);
    if (still()) return () => resize.disconnect();
    let unsubscribe: (() => void) | null = null;
    // Frames only while the hoop is on screen.
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) unsubscribe ??= subscribe(draw);
      else {
        unsubscribe?.();
        unsubscribe = null;
      }
    });
    seen.observe(holder);
    return () => {
      unsubscribe?.();
      seen.disconnect();
      resize.disconnect();
    };
  }, [shape, tilt, sway, tube, phase, direction, letters]);
  return <canvas ref={canvas} aria-hidden className={cn('pointer-events-none absolute block', className)} />;
}
