'use client';

import { memo, useEffect, useRef } from 'react';

import {
  createGradientRenderer,
  drawGradientStill,
  pixelScale,
  type GradientDrawParams,
} from './gradient-wallpaper-gl';
import {
  DEFAULT_WALLPAPER_OPACITY,
  gradientColors,
  type GradientConfig,
  type GradientPattern,
} from '../theme/wallpaper-gradients';
import { useWallpaperTheme } from './wallpaper-shaders';

/** 30 fps. The motion is a slow drift: a higher rate shows nothing more. */
const FRAME_MS = 1000 / 30;
/** Shader time units per second. One sway of a band takes about 80 s. */
const SPEED = 0.05;

/** A picker thumbnail's canvas: the composition of a 960×540 page. */
const STILL_WIDTH = 480;
const STILL_HEIGHT = 270;

function drawParams(config: GradientConfig, isDark: boolean): GradientDrawParams {
  return {
    pattern: config.pattern,
    finish: config.finish,
    colors: gradientColors(config, isDark),
    calm: config.calm,
    anchor: config.anchor,
  };
}

/** Where each pattern keeps its color, for the fallback's one soft glow. */
const FALLBACK_AT: Record<GradientPattern, string> = {
  bloom: '100% 100%',
  beam: '90% 0%',
  sheet: '0% 0%',
  bands: '50% 110%',
  horizon: '50% 100%',
  arc: '50% 100%',
  mesh: '0% 100%',
  clouds: '50% 110%',
};

/**
 * What paints when WebGL is unavailable or would run on the CPU: one static
 * glow through the whole palette, core color at the center. No canvas, no
 * frames.
 */
function fallbackBackground(params: GradientDrawParams): string {
  const at =
    (params.pattern === 'bloom' || params.pattern === 'sheet') && params.anchor
      ? `${params.anchor[0] * 100}% ${params.anchor[1] * 100}%`
      : FALLBACK_AT[params.pattern];
  // The palette runs edge to core, the glow runs core to edge. `59` is 35%
  // alpha on a six-digit hex color. The stops spread over the first 55%.
  const stops = [...params.colors]
    .reverse()
    .map((color, index, all) => `${color}59 ${Math.round((index / all.length) * 55)}%`);
  return `radial-gradient(ellipse 70% 60% at ${at}, ${stops.join(', ')}, transparent 70%)`;
}

/**
 * A full-bleed gradient wallpaper on one small WebGL canvas.
 *
 * Nothing here goes through React state per frame. The loop writes one
 * uniform and issues one draw call. It stops while the canvas is off screen,
 * and reduced motion draws a single still frame. See
 * `primitives/gradient-wallpaper-gl.ts` for the frame budget.
 */
export const GradientWallpaper = memo(function GradientWallpaper({
  config,
}: {
  config: GradientConfig;
}) {
  const { isDark, reduceMotion } = useWallpaperTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paramsRef = useRef<GradientDrawParams>(drawParams(config, isDark));
  const reduceMotionRef = useRef(reduceMotion);
  /** Set by the mount effect: applies new parameters or a new motion setting. */
  const applyRef = useRef<() => void>(() => {});

  useEffect(() => {
    paramsRef.current = drawParams(config, isDark);
    reduceMotionRef.current = reduceMotion;
    applyRef.current();
  }, [config, isDark, reduceMotion]);

  // Mount only. The renderer, the observers and the context listeners live
  // as long as the canvas; parameters and the motion setting arrive by ref.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let renderer = createGradientRenderer(canvas);
    let raf = 0;
    let still = 0;
    let lastFrame = 0;
    let deadline = 0;
    let clock = 0;
    let onScreen = true;
    // The canvas is behind what it should show: set while off screen.
    let stale = false;

    const moving = () => !reduceMotionRef.current;
    const paint = () => {
      stale = false;
      if (renderer) {
        host.style.background = '';
        renderer.draw(paramsRef.current, clock * SPEED);
      } else {
        host.style.background = fallbackBackground(paramsRef.current);
      }
    };

    // The one way a change outside the loop reaches the canvas. A running
    // loop draws the new parameters on its next frame, inside the 30 fps cap.
    // A still canvas draws once in the next frame, however many changes
    // arrive before it. An off-screen canvas draws nothing until it returns.
    const requestPaint = () => {
      if (raf) return;
      if (!onScreen) {
        stale = true;
        return;
      }
      still ||= requestAnimationFrame(() => {
        still = 0;
        // The canvas can leave the screen between the request and the frame.
        if (onScreen) paint();
        else stale = true;
      });
    };

    const resize = () => {
      const scale = pixelScale(host.clientWidth, host.clientHeight);
      const width = Math.max(1, Math.round(host.clientWidth / scale));
      const height = Math.max(1, Math.round(host.clientHeight / scale));
      // An exact multiple of the canvas size, so every canvas pixel maps to
      // the same number of device pixels and the dither grid stays even.
      canvas.style.width = `${width * scale}px`;
      canvas.style.height = `${height * scale}px`;
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      // Setting the size clears the canvas: paint before the browser does.
      if (onScreen) paint();
      else stale = true;
    };

    // Draws on a 33.3 ms deadline that advances by one period per draw, so
    // the rate is 30 fps on any display: 60 Hz draws every second frame, and
    // 100 Hz alternates between every third and every fourth. 2 ms of slack
    // absorbs the jitter in rAF timestamps.
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now < deadline - 2) return;
      // A long gap (a background tab) must not jump the composition.
      if (lastFrame > 0) clock += Math.min(now - lastFrame, 100) / 1000;
      lastFrame = now;
      // Keep the cadence. After a start or a stall the next slot is already
      // past: count one full period from now, or the next rAF draws again.
      const next = deadline + FRAME_MS;
      deadline = next > now - 2 ? next : now + FRAME_MS;
      paint();
    };

    // Starts or stops the loop for the current visibility, motion setting
    // and context state.
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
      deadline = 0;
      if (moving() && onScreen && renderer) raf = requestAnimationFrame(frame);
      else if (onScreen && stale) requestPaint();
    };

    // New parameters keep a running loop and its timestamp: restarting it
    // on every change would let a color drag draw at the display's rate.
    applyRef.current = () => {
      const shouldRun = moving() && onScreen && renderer !== null;
      if (shouldRun !== (raf !== 0)) sync();
      requestPaint();
    };
    resize();
    paint();
    sync();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      sync();
    });
    intersectionObserver.observe(host);

    const onLost = (event: Event) => {
      event.preventDefault();
      renderer = null;
      sync();
      // With no renderer this paints the CSS fallback.
      paint();
    };
    const onRestored = () => {
      renderer = createGradientRenderer(canvas);
      paint();
      sync();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(still);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      applyRef.current = () => {};
      renderer?.destroy();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ opacity: config.opacity ?? DEFAULT_WALLPAPER_OPACITY }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0"
        style={{ imageRendering: config.finish === 'dither' ? 'pixelated' : 'auto' }}
      />
    </div>
  );
});

/**
 * A still of a gradient wallpaper for the settings picker: a 2D canvas that
 * receives one frame from the shared context. Without WebGL it shows the same
 * CSS fallback as the wallpaper.
 */
export function GradientWallpaperStill({ config }: { config: GradientConfig }) {
  const { isDark } = useWallpaperTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keyed by what the shader draws, not by object identity: a settings
  // change elsewhere rebuilds every config object, and opacity is CSS.
  const params = drawParams(config, isDark);
  const drawKey = JSON.stringify(params);

  // Drawn in the frame after commit. A color drag changes `config` many
  // times per frame, and only the last change draws.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const params: GradientDrawParams = JSON.parse(drawKey);
      if (drawGradientStill(params, canvas)) {
        canvas.style.background = '';
        return;
      }
      // Clear the last frame, or it would sit over the fallback.
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.background = fallbackBackground(params);
    });
    return () => cancelAnimationFrame(frame);
  }, [drawKey]);

  return (
    <canvas
      ref={canvasRef}
      width={STILL_WIDTH}
      height={STILL_HEIGHT}
      className="absolute inset-0 h-full w-full object-cover select-none"
      style={{ opacity: config.opacity ?? DEFAULT_WALLPAPER_OPACITY }}
    />
  );
}
