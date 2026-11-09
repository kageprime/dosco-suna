import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

/**
 * Characterization for the hero walkthrough's step timeline: the span the
 * effect animates with the Web Animations API as it fills. In one prod
 * browser the `span.animate` call threw `TypeError: Illegal invocation` out
 * of the mount effect, React escalated it to the locale error boundary, and
 * the whole home page became "Something went wrong" (KRTX-4513, Better Stack
 * pattern `5b3e2a30…`, Chrome 153 / Linux, an anonymous home visitor). The
 * timeline is an enhancement: when `animate` is missing or throws, the
 * walkthrough must keep working without auto-advance; when `animate` works,
 * it must still fill, play in view, and advance the step.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('@kortix/ui', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}));
mock.module('@phosphor-icons/react', () => ({ PauseIcon: () => null, PlayIcon: () => null }));
mock.module('./session-window', () => ({ W: 1264, H: 860 }));
mock.module('./session-chat', () => ({ SessionChat: () => <div data-stub="session-chat" /> }));
mock.module('./framework-window', () => ({
  FrameworkWindow: () => <div data-stub="framework-window" />,
}));

/** Drives the component's real motion hook through the spread module below. */
let reduced = false;
const realMotion = await import('motion/react');
mock.module('motion/react', () => ({ ...realMotion, useReducedMotion: () => reduced }));

const { WorkspaceFramework } = await import('./workspace-framework');

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: Array<{ callback: Callback; disconnected: boolean }>;
const savedObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

beforeEach(() => {
  reduced = false;
  observers = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    callback: Callback;
    disconnected = false;
    constructor(callback: Callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
});

afterEach(() => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedObserver;
});

/** The observed prod failure: the call itself throws on a real-looking span. */
const illegalAnimate = () => {
  throw new TypeError('Illegal invocation');
};

/** The node react-test-renderer hands to the animated bar's ref. */
let barNode: Record<string, unknown> = {};

function mount() {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<WorkspaceFramework />, {
      createNodeMock: (element: ReactElement) =>
        element.type === 'span' ? barNode : { node: 'root' },
    });
  });
  if (!renderer) throw new Error('WorkspaceFramework did not render');
  return renderer;
}

/** The number shown on the active step button (1-based, from the strip). */
const activeStepNumber = (renderer: ReactTestRenderer): string => {
  const button = renderer.root.find(
    (node) => node.type === 'button' && node.props['aria-current'] === 'step',
  );
  const numberSpan = button.children[0] as { children: Array<string> };
  return numberSpan.children[0]!;
};

describe('WorkspaceFramework step timeline', () => {
  test('a span.animate that throws "Illegal invocation" no longer crashes the mount', () => {
    barNode = { animate: illegalAnimate };
    const renderer = mount();
    expect(renderer.root.findByProps({ 'aria-roledescription': 'walkthrough' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  test('a span without animate (no Web Animations API) no longer crashes the mount', () => {
    const renderer = mount();
    expect(renderer.root.findByProps({ 'aria-roledescription': 'walkthrough' })).toBeTruthy();
    act(() => renderer.unmount());
  });

  test('a working animate still fills, plays in view, and advances the step', () => {
    const calls: string[] = [];
    const fill = {
      pause: () => calls.push('pause'),
      play: () => calls.push('play'),
      cancel: () => calls.push('cancel'),
      onfinish: null as ((event?: unknown) => void) | null,
    };
    barNode = {
      animate: (_keyframes: unknown, options?: { duration?: number }) => {
        calls.push(`animate ${String(options?.duration)}`);
        return fill;
      },
    };
    const renderer = mount();
    expect(calls[0]).toBe('animate 7500');
    expect(calls).toContain('pause');
    expect(calls).not.toContain('play');
    expect(activeStepNumber(renderer)).toBe('1');
    act(() => observers[0]!.callback([{ isIntersecting: true }]));
    expect(calls).toContain('play');
    act(() => fill.onfinish?.());
    expect(activeStepNumber(renderer)).toBe('2');
    act(() => renderer.unmount());
    expect(calls.filter((call) => call.startsWith('animate')).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toBe('cancel');
  });

  test('reduced motion never animates', () => {
    reduced = true;
    barNode = { animate: illegalAnimate };
    const renderer = mount();
    expect(renderer.root.findByProps({ 'aria-roledescription': 'walkthrough' })).toBeTruthy();
    act(() => renderer.unmount());
  });
});
