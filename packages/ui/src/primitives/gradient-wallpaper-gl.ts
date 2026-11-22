/**
 * The gradient wallpaper renderer: one single-pass WebGL1 fragment shader for
 * every colored wallpaper.
 *
 * Frame budget. The canvas is `pixelScale()` CSS pixels per canvas pixel
 * (2, or more on a very large page), at any device pixel ratio, and the
 * browser upscales it. A canvas never exceeds `MAX_CANVAS_PIXELS` (1 MP): a
 * 1920×1080 page is 960×540 (0.5 MP), a 3840×2160 page is 1280×720 (0.9 MP),
 * against 8.3 MP for a native canvas. The dither finish wants this anyway
 * (its dots are 2 CSS px), and the grain finish is all low frequencies, so
 * the upscale is not visible.
 *
 * Per pixel, a pattern costs 0 to 2 four-octave noise lookups (16 hashes
 * each). The dither finish evaluates the pattern twice, at the cell and at
 * its block, except for `clouds`, which evaluates it once. The worst case is
 * 4 lookups: a dithered `bloom` or `mesh`.
 *
 * The context is created with `failIfMajorPerformanceCaveat`: a browser that
 * would run WebGL on the CPU gets no canvas and the CSS fallback instead.
 *
 * The output is premultiplied color over a transparent canvas. The page's
 * real background shows through, so a wallpaper works on every interface
 * theme without knowing its background color.
 */

import {
  GRADIENT_MAX_COLORS,
  GRADIENT_PATTERNS,
  type GradientFinish,
  type GradientPattern,
} from '../theme/wallpaper-gradients';

/** The fewest CSS pixels per canvas pixel. */
export const PIXEL_SCALE = 2;
/** The most pixels a wallpaper canvas holds. */
export const MAX_CANVAS_PIXELS = 1_000_000;

/** CSS pixels per canvas pixel for a host of this CSS size: a whole number,
 *  so every canvas pixel covers the same number of device pixels. */
export function pixelScale(cssWidth: number, cssHeight: number): number {
  return Math.max(PIXEL_SCALE, Math.ceil(Math.sqrt((cssWidth * cssHeight) / MAX_CANVAS_PIXELS)));
}

export interface GradientDrawParams {
  pattern: GradientPattern;
  finish: GradientFinish;
  /** 2–5 hex colors. */
  colors: string[];
  calm: number;
  anchor?: [number, number];
}

export interface GradientRenderer {
  /** Draws one frame at `time` seconds. The canvas size is read at draw. */
  draw(params: GradientDrawParams, time: number): void;
  /** True after the browser took the context away: `draw` then does nothing. */
  isLost(): boolean;
  destroy(): void;
}

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;
uniform float u_time;
uniform float u_pattern;
uniform float u_dither;
uniform vec3 u_colors[${GRADIENT_MAX_COLORS}];
uniform float u_count;
uniform float u_calm;
uniform vec2 u_anchor;

#ifdef GL_FRAGMENT_PRECISION_HIGH
float hash(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
#else
// mediump guarantees a range of 2^14 and 10 bits of precision. This hash
// wraps its input and keeps every intermediate value under 53, so the noise
// and grain repeat every 64 units on a GPU with no highp fragment floats.
float hash(vec2 p) {
  return fract(52.9829189 * fract(dot(mod(p, 64.0), vec2(0.06711056, 0.00583715))));
}
#endif

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += amp * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amp *= 0.5;
  }
  return sum / 0.9375;
}

float bayer2(vec2 a) {
  // Parity first: the square of a raw row index leaves the mediump range.
  a = mod(floor(a), 2.0);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

// Returns (coverage, palette position), both 0..1. uv is 0..1 with y down.
// Draws every pattern 15% larger than its field (GRADIENT_SCALE), so the
// shape fills the page edges instead of ending inside them.
vec2 place(vec2 screen) {
  return (screen - 0.5) / 1.15 + 0.5;
}

vec2 field(vec2 screen) {
  float asp = u_res.x / u_res.y;
  vec2 uv = place(screen);
  float t = u_time;
  float a = 0.0;
  float c = 0.0;

  if (u_pattern < 0.5) {
    // bloom: color grows out of one corner in streaks aimed at the center.
    vec2 d = uv - u_anchor;
    d.x *= asp;
    float r = length(d) / length(vec2(asp, 1.0));
    vec2 dir = normalize(vec2((0.5 - u_anchor.x) * asp, 0.5 - u_anchor.y));
    float along = dot(d, dir);
    float across = dot(d, vec2(-dir.y, dir.x));
    float n = fbm(vec2(along * 1.3 - t * 0.6, across * 3.4 + t * 0.2));
    float m = fbm(vec2(along * 3.1 + t * 0.3, across * 6.0) + 31.7);
    a = 1.0 - smoothstep(0.0, 0.66, r + (n - 0.5) * 0.45);
    a *= a;
    a = a * (0.62 + 0.5 * m);
    c = a;
  } else if (u_pattern < 1.5) {
    // beam: a diagonal band, soft above and sharp below.
    vec2 q = vec2((uv.x - 0.5) * asp, uv.y - 0.5);
    vec2 nrm = normalize(vec2(-0.5, 1.0));
    float along = dot(q, vec2(nrm.y, -nrm.x));
    float s = dot(q, nrm) + 0.3;
    s += (fbm(vec2(along * 1.4 + t * 0.4, 3.0)) - 0.5) * 0.16;
    float soft = exp(-(s * s) / 0.1);
    float sharp = exp(-(s * s) / 0.0011);
    a = s > 0.0 ? sharp : soft;
    a *= 0.75 + 0.35 * fbm(vec2(along * 2.2 - t * 0.5, s * 9.0) + 7.0);
    c = pow(smoothstep(-0.52, 0.035, s), 1.5);
  } else if (u_pattern < 2.5) {
    // sheet: a wavy half-plane falling from the anchor corner. m is uv
    // mirrored so the anchor is its origin: (0, 0) is the top-left corner,
    // (1, 1) flips both axes to the bottom-right.
    vec2 m = abs(uv - u_anchor);
    float s = (m.x + m.y) * 0.5;
    s += 0.05 * sin(m.x * 5.0 - m.y * 2.0 + t * 1.6);
    s += (fbm(vec2(m.x * asp * 2.0 - t * 0.3, m.y * 2.4 + t * 0.2)) - 0.5) * 0.22;
    a = 1.0 - smoothstep(0.04, 0.5, s);
    c = a * a;
    a = pow(a, 0.8);
  } else if (u_pattern < 3.5) {
    // bands: vertical ribbons that sway.
    float x = uv.x * asp * 0.62;
    x += 0.2 * sin(uv.y * 2.6 + t * 0.9);
    x += (fbm(vec2(uv.x * asp * 1.1, uv.y * 1.2 - t * 0.35)) - 0.5) * 0.7;
    c = 0.5 + 0.5 * sin(x * 4.4 + 0.6);
    a = 0.4 + 0.4 * sin(x * 2.3 + 1.9 + t * 0.4);
  } else if (u_pattern < 4.5) {
    // horizon: a glowing line low on the page over a filled ground.
    float y0 = 0.74 + 0.025 * sin(uv.x * 3.0 + t * 0.8);
    float d = uv.y - y0;
    float glow = exp(-(d * d) / 0.028);
    float ground = smoothstep(-0.03, 0.13, d) * 0.85;
    a = min(glow + ground, 1.0);
    a *= 1.0 - 0.3 * pow(abs(uv.x - 0.5) * 2.0, 2.0) * (1.0 - ground);
    c = 1.0 - smoothstep(-0.26, 0.2, d);
  } else if (u_pattern < 5.5) {
    // arc: the lit rim of a sphere whose body is above the page.
    vec2 q = vec2((uv.x - 0.5) * asp, uv.y);
    float radius = 1.36 + 0.012 * sin(t * 0.9);
    float d = length(q - vec2(0.0, -0.58)) - radius;
    float inside = exp(d * 3.4);
    float outside = exp(-(d * d) / 0.0016);
    a = d < 0.0 ? inside : outside;
    c = d < 0.0 ? exp(d * 5.5) : 1.0;
  } else if (u_pattern < 6.5) {
    // mesh: four pools of light drifting in the corners.
    vec2 w = uv + (vec2(fbm(uv * 2.0 + t * 0.2), fbm(uv * 2.0 + 13.0 - t * 0.2)) - 0.5) * 0.22;
    float sum = 0.0;
    float cs = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 base = vec2(
        mod(fi, 2.0) < 0.5 ? 0.06 : 0.94,
        fi < 1.5 ? 0.1 : 0.92
      );
      vec2 pos = base + 0.09 * vec2(sin(t * 0.7 + fi * 1.7), cos(t * 0.5 + fi * 2.3));
      vec2 dd = w - pos;
      dd.x *= asp * 0.75;
      float wgt = exp(-dot(dd, dd) / 0.085);
      sum += wgt;
      cs += wgt * (fi < 0.5 ? 0.15 : fi < 1.5 ? 0.95 : fi < 2.5 ? 0.6 : 0.35);
    }
    a = clamp(sum, 0.0, 1.0);
    c = cs / max(sum, 0.0001);
  } else {
    // clouds: thresholded noise in two banks that rise from the bottom
    // corners and taper under the centered content.
    vec2 p = vec2(uv.x * asp * 1.25 + t * 0.25, uv.y * 1.7);
    float w = fbm(p * 1.6 + 4.0);
    float n = fbm(p + 0.7 * vec2(w, 1.0 - w));
    float side = 0.5 + 0.8 * abs(uv.x - 0.5) * 2.0;
    float lift = 0.46 + 0.62 * smoothstep(0.25, 1.0, uv.y) * side;
    float v = n * lift;
    a = smoothstep(0.4, 0.58, v);
    c = smoothstep(0.42, 0.8, v);
  }

  // Clear the shape behind the centered content.
  // On a narrow page the content spans the full width, so the cleared area
  // widens as the aspect ratio falls below 1.6.
  vec2 k = screen - vec2(0.5, 0.46);
  k.x *= min(asp, 1.6) / 1.6;
  a *= 1.0 - u_calm * exp(-(k.x * k.x) / 0.15 - (k.y * k.y) / 0.06);
  return clamp(vec2(a, c), 0.0, 1.0);
}

vec3 paletteSmooth(float c) {
  float x = c * (u_count - 1.0);
  vec3 col = u_colors[0];
  for (int i = 1; i < ${GRADIENT_MAX_COLORS}; i++) {
    col = mix(col, u_colors[i], clamp(x - float(i - 1), 0.0, 1.0));
  }
  return col;
}

vec3 paletteStep(float index) {
  vec3 col = u_colors[0];
  for (int i = 1; i < ${GRADIENT_MAX_COLORS}; i++) {
    col = mix(col, u_colors[i], step(float(i), index));
  }
  return col;
}

void main() {
  vec2 fc = floor(gl_FragCoord.xy);
  fc.y = u_res.y - 1.0 - fc.y;

  if (u_dither > 0.5) {
    // A cell is 2×2 canvas pixels. Its top-left pixel is the dot. Dots fire
    // first, in bayer order, so low coverage reads as a sparse dot grid; the
    // other three pixels then fill the cell, so high coverage reads as
    // solid blocks.
    vec2 cell = floor(fc / 2.0);
    vec2 sub = fc - cell * 2.0;
    vec2 uvCell = (cell * 2.0 + 1.0) / u_res;
    vec2 block = floor(cell / 3.0) * 3.0 + 1.5;
    vec2 uvBlock = (block * 2.0) / u_res;
    // The block sample gives the pixel-art steps. Clouds skip it: their
    // edge should stay round, and it halves their cost.
    vec2 f = field(uvCell);
    // It fades out with coverage, so a faint outer edge stays a soft dot
    // field and only the dense core steps.
    if (u_pattern < 6.5) {
      vec2 fb = field(uvBlock);
      f = mix(f, fb, 0.4 * smoothstep(0.1, 0.5, fb.x));
    }

    bool isDot = sub.x < 0.5 && sub.y < 0.5;
    float threshold = isDot
      ? bayer8(cell) * 0.4 + 0.004
      : 0.4 + 0.6 * bayer8(cell + vec2(5.0, 3.0));
    if (f.x <= threshold) {
      gl_FragColor = vec4(0.0);
      return;
    }
    float index = floor(f.y * (u_count - 1.0) + bayer8(cell + vec2(2.0, 7.0)));
    gl_FragColor = vec4(paletteStep(index), 1.0);
    return;
  }

  vec2 f = field((fc + 0.5) / u_res);
  // Static grain: it hides 8-bit banding and gives the print texture.
  float g = hash(fc + 3.7) - 0.5;
  vec3 col = paletteSmooth(f.y) + g * 0.07;
  float alpha = clamp(f.x + g * 0.03, 0.0, 1.0);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}
`;

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** The `u_colors` uniform: `colors` as RGB triples, padded with the last. */
export function packColors(colors: string[]): Float32Array {
  const packed = new Float32Array(GRADIENT_MAX_COLORS * 3);
  const count = Math.min(colors.length, GRADIENT_MAX_COLORS);
  for (let i = 0; i < GRADIENT_MAX_COLORS; i++) {
    packed.set(hexToRgb(colors[Math.min(i, count - 1)]!), i * 3);
  }
  return packed;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Returns null when WebGL is unavailable or the program does not build. The
 * caller then renders nothing: a wallpaper is decoration.
 */
export function createGradientRenderer(canvas: HTMLCanvasElement): GradientRenderer | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'low-power',
      // No software WebGL: a CPU rasterizer cannot hold the frame budget.
      failIfMajorPerformanceCaveat: true,
    });
  } catch {
    return null;
  }
  if (!gl) return null;
  const context = gl;

  const vertex = compile(context, context.VERTEX_SHADER, VERTEX);
  const fragment = compile(context, context.FRAGMENT_SHADER, FRAGMENT);
  const program = context.createProgram();
  if (!vertex || !fragment || !program) return null;
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) return null;
  context.useProgram(program);

  // One triangle that covers the viewport.
  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(
    context.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    context.STATIC_DRAW,
  );
  const position = context.getAttribLocation(program, 'a_pos');
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

  const uniform = (name: string) => context.getUniformLocation(program, name);
  const uRes = uniform('u_res');
  const uTime = uniform('u_time');
  const uPattern = uniform('u_pattern');
  const uDither = uniform('u_dither');
  const uColors = uniform('u_colors[0]');
  const uCount = uniform('u_count');
  const uCalm = uniform('u_calm');
  const uAnchor = uniform('u_anchor');

  // An animation frame changes only the time. The size and the wallpaper's
  // own uniforms are sent again only when they change.
  let sentParams: GradientDrawParams | null = null;
  let sentWidth = 0;
  let sentHeight = 0;

  return {
    draw(params, time) {
      if (context.isContextLost()) return;
      const { width, height } = canvas;
      if (width !== sentWidth || height !== sentHeight) {
        context.viewport(0, 0, width, height);
        context.uniform2f(uRes, width, height);
        sentWidth = width;
        sentHeight = height;
      }
      if (params !== sentParams) {
        context.uniform1f(uPattern, GRADIENT_PATTERNS.indexOf(params.pattern));
        context.uniform1f(uDither, params.finish === 'dither' ? 1 : 0);
        context.uniform3fv(uColors, packColors(params.colors));
        context.uniform1f(uCount, Math.min(params.colors.length, GRADIENT_MAX_COLORS));
        context.uniform1f(uCalm, params.calm);
        context.uniform2f(uAnchor, params.anchor?.[0] ?? 1, params.anchor?.[1] ?? 1);
        sentParams = params;
      }
      context.uniform1f(uTime, time);
      context.drawArrays(context.TRIANGLES, 0, 3);
    },
    isLost: () => context.isContextLost(),
    destroy() {
      context.deleteBuffer(buffer);
      context.deleteProgram(program);
      context.deleteShader(vertex);
      context.deleteShader(fragment);
      // Give the context back once the canvas has left the document. A
      // browser keeps about 16 and then drops the oldest. Deferred, because
      // React's strict mode destroys and recreates on a canvas that stays.
      setTimeout(() => {
        if (!canvas.isConnected) context.getExtension('WEBGL_lose_context')?.loseContext();
      }, 0);
    },
  };
}

// ── Stills ───────────────────────────────────────────────────────────────
// The settings picker shows eleven gradients at once. A live WebGL canvas per
// card would hold eleven contexts, so each card is a 2D canvas that receives
// one frame from a single shared offscreen context. The copy stays on the
// GPU: no readback and no image encode.

let still: { canvas: HTMLCanvasElement; renderer: GradientRenderer } | null = null;
/** WebGL refused at this time: stills skip the attempt for a while. */
let stillFailedAt = Number.NEGATIVE_INFINITY;
/** 11 thumbnails mount together. One refusal covers them all, then a
 *  later draw may try again. */
const STILL_RETRY_MS = 5000;

/**
 * Draws one frame into `target`, a 2D canvas, at the target's own size. That
 * size is the canvas a page would get: a 480×270 target shows what a 960×540
 * page shows. Returns false, and leaves the target alone, without WebGL.
 */
export function drawGradientStill(params: GradientDrawParams, target: HTMLCanvasElement): boolean {
  // A lost context draws nothing: drop it and build a new one.
  if (still?.renderer.isLost()) still = null;
  if (!still) {
    if (performance.now() - stillFailedAt < STILL_RETRY_MS) return false;
    const canvas = document.createElement('canvas');
    const renderer = createGradientRenderer(canvas);
    if (!renderer) {
      stillFailedAt = performance.now();
      return false;
    }
    still = { canvas, renderer };
  }
  const context = target.getContext('2d');
  if (!context) return false;
  // Assigning a size reallocates the drawing buffer, even to the same size.
  if (still.canvas.width !== target.width) still.canvas.width = target.width;
  if (still.canvas.height !== target.height) still.canvas.height = target.height;
  still.renderer.draw(params, 0);
  if (still.renderer.isLost()) return false;
  // Copy in the same task as the draw: the drawing buffer is cleared after.
  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(still.canvas, 0, 0);
  return true;
}
