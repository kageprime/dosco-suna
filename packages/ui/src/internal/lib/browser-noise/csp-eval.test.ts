import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldIgnoreBrowserRuntimeNoise, shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

// KRTX-4423: a crawler's automation driver evaluates a string in the page; the
// CSP blocks it and the injected `<anonymous>` script rejects with EvalError.
const message =
  "Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://www.googletagmanager.com\".\n";
const frames = [
  { filename: '<anonymous>', function: 'next' },
  { filename: '<anonymous>', function: 'predicate' },
  { filename: '<anonymous>', function: 'eval' },
];

function event(value = message, stack = frames) {
  return {
    exception: {
      values: [
        {
          type: 'EvalError',
          value,
          mechanism: { type: 'auto.browser.global_handlers.onunhandledrejection', handled: false },
          stacktrace: { frames: stack },
        },
      ],
    },
  };
}

test('filters a CSP-blocked eval raised only by injected <anonymous> code', () => {
  expect(shouldIgnoreSentryBrowserNoise(event())).toBe(true);
});

test('preserves an eval from our bundles, a blob worker, first-party source, vendors, no stack and other messages', () => {
  for (const filename of [
    'app:///_next/static/chunks/a.js',
    // KRTX-3580: a bundled decoder's blob worker called `new Function`.
    'blob:https://kortix.com/00000000-0000-4000-8000-000000000000',
    'apps/web/src/app/page.tsx',
    'packages/ui/src/session/index.ts',
    'https://www.googletagmanager.com/gtm.js',
  ]) {
    expect(shouldIgnoreSentryBrowserNoise(event(message, [...frames, { filename, function: 'run' }]))).toBe(false);
  }
  expect(shouldIgnoreSentryBrowserNoise(event(message, []))).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(event('Evaluating a string as JavaScript is not allowed'))).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ message })).toBe(false);
});

// KRTX-5011: heic2any's decoder worker calls `new Function` at worker line
// 2:1320381 (the KRTX-3580 frame). Kortix replaced heic2any with `heic-to/csp`
// in PR #10981, yet prod reported the frame again from logged-out `/auth`
// loads: a third-party script (a browser extension) that bundles heic2any
// starts the worker on the page, and the worker inherits our CSP.
const heic2anyWorkerFrame = {
  filename: 'blob:app:///00000000-0000-4000-8000-000000000000',
  function: '?',
  lineno: 2,
  colno: 1320381,
};

function workerEvent(value = `Uncaught EvalError: ${message}`, stack: object[] = [heic2anyWorkerFrame]) {
  return {
    exception: {
      values: [
        {
          type: 'Error',
          value,
          mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
          stacktrace: { frames: stack },
        },
      ],
    },
  };
}

test('filters the CSP-blocked eval of a third-party heic2any blob worker', () => {
  expect(shouldIgnoreSentryBrowserNoise(workerEvent())).toBe(true);
  expect(shouldIgnoreSentryBrowserNoise(workerEvent(message))).toBe(true);
});

test('preserves any other blob-worker eval, an extra frame and other messages', () => {
  for (const frame of [
    { ...heic2anyWorkerFrame, colno: 1320380 },
    { ...heic2anyWorkerFrame, lineno: 1 },
    { ...heic2anyWorkerFrame, filename: 'app:///_next/static/chunks/a.js' },
    { filename: heic2anyWorkerFrame.filename, function: '?' },
  ]) {
    expect(shouldIgnoreSentryBrowserNoise(workerEvent(undefined, [frame]))).toBe(false);
  }
  expect(
    shouldIgnoreSentryBrowserNoise(
      workerEvent(undefined, [{ filename: 'packages/ui/src/internal/lib/utils/heic-convert.ts' }, heic2anyWorkerFrame]),
    ),
  ).toBe(false);
  expect(shouldIgnoreSentryBrowserNoise(workerEvent('Uncaught EvalError: Evaluating a string is not allowed'))).toBe(
    false,
  );
});

test('the heic2any worker cannot be first-party: no workspace depends on heic2any', () => {
  const lockfile = readFileSync(join(import.meta.dir, '../../../../../../pnpm-lock.yaml'), 'utf8');
  expect(lockfile).not.toContain('heic2any');
});
