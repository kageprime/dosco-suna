import { expect, test } from 'bun:test';
import {
  isTrackingPixelResponseJsonNoise,
  shouldIgnoreBrowserRuntimeNoise,
  shouldIgnoreSentryBrowserNoise,
} from '../browser-error-noise';

// KRTX-4624: a third-party tracking pixel (Vector, `https://cdn.vector.co/pixel.js`)
// fetched its own API, bot protection answered 403 with an empty body, and the
// pixel's own `response.json()` call rejected with the DOM
// `SyntaxError: Failed to execute 'json' on 'Response': Unexpected end of JSON
// input`. The pixel catches the rejection but it still surfaced unhandled, so
// Sentry's global handler captured it and it paged Better Stack. The client was
// a Naver Yeti crawler (`Yeti/1.1`, `browser.type: "bot"`), 1 occurrence / 0
// identified users. The throw is in the vendor's script (all 5 frames
// `app:///pixel.js`), never first-party code, and first-party code cannot fix
// the vendor's missing `response.ok` check.
const MESSAGE = "Failed to execute 'json' on 'Response': Unexpected end of JSON input";

// The five production stack frames, all the vendor script (Sentry's Next.js
// frame normalization rewrites the cross-origin `https://cdn.vector.co/pixel.js`
// to the `app:///pixel.js` shape), oldest first.
const PROD_FRAMES = [
  { filename: 'app:///pixel.js', function: 'a' },
  { filename: 'app:///pixel.js', function: 's' },
  { filename: 'app:///pixel.js', function: 'Generator.next' },
  { filename: 'app:///pixel.js', function: 'Generator.<anonymous>' },
  { filename: 'app:///pixel.js', function: 'e.<anonymous>' },
];

function event(value = MESSAGE, stack = PROD_FRAMES) {
  return {
    request: { url: 'https://kortix.com/' },
    exception: {
      values: [
        {
          type: 'SyntaxError',
          value,
          mechanism: { type: 'auto.browser.global_handlers.onunhandledrejection', handled: false },
          stacktrace: { frames: stack },
        },
      ],
    },
  };
}

test('filters the tracking-pixel Response.json prod event through Sentry', () => {
  // Exact production shape: the DOM `Response.json()` rejection + the five
  // `app:///pixel.js` frames + the unhandledrejection mechanism.
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
  // The un-normalized vendor script URL (the raw in-page rejection stack shape)
  // is the same class.
  expect(
    shouldIgnoreSentryBrowserNoise(event(MESSAGE, [{ filename: 'https://cdn.vector.co/pixel.js', function: 'e.<anonymous>' }])),
  ).toBe(true);
});

test('keeps first-party Response.json regressions reporting', () => {
  // Our own code calls `response.json()`; the same wording from a first-party
  // bundle chunk (the throw site) is an actionable regression.
  expect(
    shouldIgnoreSentryBrowserNoise(event(MESSAGE, [
      { filename: 'app:///_next/static/chunks/414c69f9-e0c657363ae93f0c.js', function: 'fetchJson' },
    ])),
  ).toBe(false);
  // A de-minified first-party source anywhere in the stack keeps reporting.
  expect(
    shouldIgnoreSentryBrowserNoise(event(MESSAGE, [
      ...PROD_FRAMES,
      { filename: 'apps/web/src/lib/api/client.ts', function: 'parseResponse' },
    ])),
  ).toBe(false);
  // A frameless capture is unattributable and this message class routinely
  // comes from first-party fetch code — keep reporting (unlike googletag).
  expect(shouldIgnoreSentryBrowserNoise(event(MESSAGE, []))).toBe(false);
});

test('other errors from the pixel script and other messages keep reporting', () => {
  // A different error inside the pixel is a different signal.
  expect(
    shouldIgnoreSentryBrowserNoise(event('Cannot read properties of undefined (reading length)')),
  ).toBe(false);
  // A lookalike message is not the class.
  expect(shouldIgnoreSentryBrowserNoise(event('Unexpected end of JSON input'))).toBe(false);
});

test('the runtime gate never drops the class (it carries no frame evidence)', () => {
  expect(shouldIgnoreBrowserRuntimeNoise({ message: MESSAGE })).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ reason: { name: 'SyntaxError', message: MESSAGE } })).toBe(false);
});

test('the predicate itself: exact message, throw-site pixel frame, negative guards', () => {
  // The exact prod shape, and the SyntaxError-wrapped form.
  expect(isTrackingPixelResponseJsonNoise({ message: MESSAGE, frames: PROD_FRAMES })).toBe(true);
  expect(isTrackingPixelResponseJsonNoise({ message: `SyntaxError: ${MESSAGE}`, frames: PROD_FRAMES })).toBe(true);
  // A wrapped vendor URL with a query string is still the pixel script.
  expect(
    isTrackingPixelResponseJsonNoise({ message: MESSAGE, frames: [{ filename: 'https://cdn.vector.co/pixel.js?v=2' }] }),
  ).toBe(true);
  // A lookalike first-party asset path inside the bundle never classifies.
  expect(
    isTrackingPixelResponseJsonNoise({
      message: MESSAGE,
      frames: [{ filename: 'app:///_next/static/chunks/pixel.js', function: 'f' }],
    }),
  ).toBe(false);
  // No frames → unattributable → keep reporting.
  expect(isTrackingPixelResponseJsonNoise({ message: MESSAGE, frames: [] })).toBe(false);
});

test('the pixel-script frame check keeps the regex shape and runs in linear time', () => {
  const pixel = (filename: string) => isTrackingPixelResponseJsonNoise({ message: MESSAGE, frames: [{ filename }] });
  expect(pixel('https://cdn.vector.co/pixel.js#frag')).toBe(true);
  expect(pixel('https://cdn.vector.co/pixel.jsx')).toBe(false);
  expect(pixel('https://cdn.vector.co/pixel.js/next.js')).toBe(false);
  expect(pixel('https://cdn.vector.co/pixel.js?v=2\nmore')).toBe(false);
  // CodeQL js/polynomial-redos input: many `pixel.js#` repetitions that end in
  // a line break and a non-match. The old regex backtracked quadratically here.
  const adversarial = `https://x/${'pixel.js#'.repeat(50_000)}\n!`;
  const started = performance.now();
  expect(pixel(adversarial)).toBe(false);
  expect(performance.now() - started).toBeLessThan(200);
  expect(pixel(`https://x/${'pixel.js#'.repeat(50_000)}`)).toBe(true);
});
