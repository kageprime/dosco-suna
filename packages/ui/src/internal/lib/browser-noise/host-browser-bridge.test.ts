import { expect, test } from 'bun:test';
import { shouldIgnoreBrowserRuntimeNoise, shouldIgnoreSentryBrowserNoise } from '../browser-error-noise';

type Frame = { filename: string; function: string };

const sentryTimerWrapper = { filename: 'app:///_next/static/immutable/chunks/synthetic.js', function: 'r' };
const injected = (fn: string) => ({ filename: '<anonymous>', function: fn });

function event(value: string, frames: Frame[]) {
  return { exception: { values: [{ type: 'ReferenceError', value, stacktrace: { frames } }] } };
}

test('drops the host-browser bridge ReferenceErrors in their observed frame shapes', () => {
  // Frames are oldest first; the last one is the throw site.
  const shapes: Array<[string, Frame[]]> = [
    ['swbrowser is not defined', [injected('?'), injected('needInjectCss')]],
    ['xbrowser is not defined', [injected('execute_auto_fill')]],
    ['xbrowser is not defined', [sentryTimerWrapper, injected('execute_auto_fill')]],
    ['xbrowser is not defined', [sentryTimerWrapper, injected('?'), injected('execute_auto_fill')]],
  ];
  for (const [value, frames] of shapes) {
    expect(shouldIgnoreSentryBrowserNoise(event(value, frames))).toBe(true);
  }
});

test('keeps reporting when the throw is ours or unattributable', () => {
  const message = 'xbrowser is not defined';
  // Our bundle at the throw site.
  expect(shouldIgnoreSentryBrowserNoise(event(message, [injected('execute_auto_fill'), sentryTimerWrapper]))).toBe(false);
  // A de-minified first-party frame anywhere in the stack.
  expect(
    shouldIgnoreSentryBrowserNoise(
      event(message, [{ filename: 'app:///apps/web/src/app/auth/page.tsx', function: 'AuthPage' }, injected('?')]),
    ),
  ).toBe(false);
  // No stack, and the runtime gate (no frames to anchor on).
  expect(shouldIgnoreSentryBrowserNoise(event(message, []))).toBe(false);
  expect(shouldIgnoreBrowserRuntimeNoise({ message: `Uncaught ReferenceError: ${message}`, filename: '' })).toBe(false);
  // Any other undefined global from injected code.
  expect(shouldIgnoreSentryBrowserNoise(event('zzbrowser is not defined', [injected('needInjectCss')]))).toBe(false);
});
