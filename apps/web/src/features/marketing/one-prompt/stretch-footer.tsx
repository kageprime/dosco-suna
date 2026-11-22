'use client';

import { useEffect, useRef } from 'react';
import { HOOP_PALETTE } from './hoop-palette';
import { CopyButton } from './parts';

const VERTEX = `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// A stepped rainbow arch as a living dither field. The arch is soft on every
// edge, like a blurred light: neighbouring columns melt into each other and
// the crest thins out. fbm flow moves the dots and the band seams over time.
// One canvas pixel is one dither cell; CSS scales it up with pixelated sampling.
const FRAGMENT = `
  precision highp float;
  uniform vec2 resolution;
  uniform float time;
  uniform float stretch;
  uniform vec3 palette[4]; // floor to crest

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(4.1, 1.7); a *= 0.5; }
    return v;
  }
  float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

  const float COLUMNS = 9.0;
  // Column height, 0-1: tallest in the middle, a third at the edges.
  float column(float i) {
    float d = abs(clamp(i, 0.0, COLUMNS - 1.0) - (COLUMNS - 1.0) * 0.5) / ((COLUMNS - 1.0) * 0.5);
    return 1.0 - 0.6 * pow(d, 1.15);
  }

  void main() {
    vec2 cell = floor(gl_FragCoord.xy);
    vec2 uv = cell / resolution; // y = 0 at the floor
    float t = time;

    // Stepped profile with soft seams: each seam blends across part of a column.
    float c = uv.x * COLUMNS;
    float i = floor(c);
    float f = fract(c);
    float h = column(i);
    float seam = 0.07;
    h += (column(i - 1.0) - h) * 0.5 * (1.0 - smoothstep(0.0, seam, f));
    h += (column(i + 1.0) - h) * 0.5 * smoothstep(1.0 - seam, 1.0, f);

    float top = h * stretch;
    if (top <= 0.001) { gl_FragColor = vec4(0.0); return; }
    float g = uv.y / top; // 0 at the floor, 1 at the crest

    // Flow: a slow drift up the arch, so the bands breathe.
    vec2 q = vec2(uv.x * 5.0, uv.y * 3.0 - t * 0.12);
    float flow = fbm(q + vec2(fbm(q * 1.4 + t * 0.07), 0.0));
    float gw = g + (flow - 0.5) * 0.12;

    // A soft crest, like a blur: the top of each column thins to nothing.
    float fade = 1.0 - smoothstep(0.8, 1.06, gw);
    float level = fade * mix(0.78, 1.08, flow);
    float on = step(bayer8(cell) + 0.01, level);

    // Bands, dithered into each other with a second, shifted threshold.
    // The bands span the solid body, so the red crest stays thick before it fades.
    float k = clamp(gw / 0.86, 0.0, 0.999) * 3.0;
    float band = floor(k);
    float pick = step(bayer8(cell + vec2(3.0, 5.0)), fract(k));
    float idx = band + pick;
    vec3 color = idx < 0.5 ? palette[0] : idx < 1.5 ? palette[1] : idx < 2.5 ? palette[2] : palette[3];

    float alpha = on * 0.92;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

/** `#RRGGBB` as 0–1 RGB. */
function hexToRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Floor to crest: blue, green, yellow, red. */
const BANDS = [HOOP_PALETTE[1], HOOP_PALETTE[2], HOOP_PALETTE[3], HOOP_PALETTE[0]].flatMap(hexToRgb);

/** CSS pixels per dither cell. */
const CELL = 3;

/** Spring response in seconds (Apple's model). Damping ratio is 1: no overshoot. */
const RESPONSE = 0.35;

/**
 * The page ends on a rainbow that is not there until you scroll past the
 * last line. Below the content is a stretch zone: as it scrolls in, the
 * content moves up and an animated dither arch stretches up from the
 * viewport bottom to fill it, then shrinks back when you scroll up.
 *
 * Scroll sets a target. A critically damped spring chases it, so wheel steps
 * blend into one motion. The arch hangs from a sticky line the compositor
 * pins to the viewport bottom. WebGL at one pixel per 3px cell; the loop runs
 * only while the zone is on screen. Reduced motion: no flow, no spring.
 */
export function StretchFooter({ prompt }: { prompt: string }) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const zone = zoneRef.current;
    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl', { premultipliedAlpha: true, antialias: false });
    // Automation browsers can hand back a stub without WebGL methods (KRTX-4536).
    if (!zone || !canvas || !gl || typeof gl.createProgram !== 'function') return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    const shaders = [compile(gl.VERTEX_SHADER, VERTEX), compile(gl.FRAGMENT_SHADER, FRAGMENT)];
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    // The program keeps what it linked: the shaders can go either way.
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uResolution = gl.getUniformLocation(program, 'resolution');
    const uTime = gl.getUniformLocation(program, 'time');
    const uStretch = gl.getUniformLocation(program, 'stretch');
    gl.uniform3fv(gl.getUniformLocation(program, 'palette'), BANDS);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const omega = (2 * Math.PI) / RESPONSE;
    let top = 0;
    let span = 1;
    let target = 0;
    let shown = 0;
    let velocity = 0;
    let visible = false;
    let frame = 0;
    let last = 0;

    const draw = (now: number) => {
      const p = shown < 0 ? 0 : shown > 1 ? 1 : shown;
      gl.uniform1f(uStretch, p ** 1.4);
      gl.uniform1f(uTime, reduced.matches ? 4 : now / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      zone.dataset.progress = p.toFixed(3);
    };

    const readTarget = () => {
      const p = (window.scrollY + window.innerHeight - top) / span;
      return p <= 0 ? 0 : p >= 1 ? 1 : p;
    };

    const tick = (now: number) => {
      frame = 0;
      const dt = last ? Math.min(0.064, (now - last) / 1000) : 1 / 60;
      last = now;
      target = readTarget();
      if (reduced.matches) {
        shown = target;
        velocity = 0;
      } else {
        // Critically damped spring in 4 ms steps, stable through a long frame.
        for (let left = dt; left > 0; left -= 0.004) {
          const h = Math.min(0.004, left);
          velocity += (omega * omega * (target - shown) - 2 * omega * velocity) * h;
          shown += velocity * h;
        }
        if (Math.abs(target - shown) < 0.0005 && Math.abs(velocity) < 0.005) {
          shown = target;
          velocity = 0;
        }
      }
      draw(now);
      // The dots flow while the arch is up; a settled, empty arch sleeps.
      const moving = velocity !== 0 || shown !== target;
      if (visible && (moving || (shown > 0 && !reduced.matches))) frame = requestAnimationFrame(tick);
      else last = 0;
    };

    const wake = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const measure = () => {
      const rect = zone.getBoundingClientRect();
      top = rect.top + window.scrollY;
      span = Math.max(1, rect.height);
      const width = Math.max(1, Math.round(canvas.clientWidth / CELL));
      const height = Math.max(1, Math.round(canvas.clientHeight / CELL));
      if (width !== canvas.width || height !== canvas.height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      wake();
    };

    measure();
    shown = target = readTarget();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(zone);
    resizeObserver.observe(canvas);
    resizeObserver.observe(document.documentElement);
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) {
        wake();
        return;
      }
      // Off screen: settle at rest and clear, so a fast scroll back up never shows a stale arch.
      shown = target = 0;
      velocity = 0;
      draw(0);
    });
    // Watch the whole footer: the arch is pinned while any of it is on screen,
    // so the loop must run until the spring has brought it back to zero.
    viewObserver.observe(zone.parentElement ?? zone);
    const onScroll = () => {
      if (visible) wake();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    reduced.addEventListener('change', wake);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      viewObserver.disconnect();
      window.removeEventListener('scroll', onScroll);
      reduced.removeEventListener('change', wake);
      gl.useProgram(null);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <footer id="site-footer" className="relative isolate overflow-clip bg-background">
      <div className="relative z-10">
        <FooterContent prompt={prompt} />
      </div>
      {/* The stretch zone: empty scroll space the arch grows into. */}
      <div ref={zoneRef} aria-hidden className="h-[56svh] min-h-[320px]" />
      {/* A zero-height line the compositor pins to the viewport bottom: the arch grows up from it. */}
      <div aria-hidden className="pointer-events-none sticky bottom-0 z-0 h-0">
        <canvas ref={canvasRef} className="absolute inset-x-0 bottom-0 block h-[58svh] min-h-[330px] w-full [image-rendering:pixelated]" />
      </div>
    </footer>
  );
}

/** The closing title and the copy button. The name lives in the header and the copy dialog. */
function FooterContent({ prompt }: { prompt: string }) {
  return (
    <div className="flex flex-col items-center gap-7 px-4 pt-48 pb-24 text-center sm:px-6">
      <h2 className="text-foreground text-4xl tracking-tight sm:text-5xl lg:text-6xl">
        One prompt.<br /><span className="text-muted-foreground">Your whole company, looped.</span>
      </h2>
      <CopyButton text={prompt} icon="shortcut" bindKey={false} />
      {/* The page is also served on loopmaxxing.sh: the legal pages live on kortix.com. */}
      <nav aria-label="Legal" className="text-muted-foreground flex gap-4 text-sm">
        <a href="https://kortix.com/legal?tab=privacy" className="hover:text-foreground transition-colors">
          Privacy
        </a>
        <a href="https://kortix.com/legal/terms" className="hover:text-foreground transition-colors">
          Terms
        </a>
      </nav>
    </div>
  );
}
