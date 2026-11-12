import { OtpVerification } from '@/features/auth/phone-verification/otp-verification';
import { fullDate, STATUS_META } from '@/lib/kortix/task-meta';
import { beforeEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { AnimatedBg, ArcSvg, LEFT_ARC, RIGHT_ARC } from './animated-bg';

test('hero first render keeps its static gradient, hidden decoration and bottom fade', () => {
  const html = renderToStaticMarkup(<AnimatedBg duration={7} />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('-z-10');
  expect(html).toContain('radial-gradient(ellipse at 20% 30%');
  expect(html).toContain('bg-gradient-to-t');
});

test('both arc shapes retain geometry and tones', () => {
  for (const cfg of [LEFT_ARC, RIGHT_ARC]) {
    // KRTX-4727: the `blur(3px)` assertion moved to the wrapper's keyframes
    // below — ArcSvg no longer takes a `blurAmount` prop, motion drives the
    // blur through `animate.filter` with the same `times` as x/y/scale.
    const html = renderToStaticMarkup(<ArcSvg cfg={cfg} size={100} tone="dark" opacity={0.23} />);
    expect(html).toContain(cfg.d);
    expect(html).toContain('width="100"');
    expect(html).toContain(`height="${100 * cfg.ratio}"`);
    expect(html).toContain('#B9B9B9');
  }
});

test('OTP idle and challenged states retain their available actions', () => {
  const props = { onVerify: async () => {}, onResend: async () => {}, onSendCode: async () => {}, onRemovePhone: async () => {} };
  const idle = renderToStaticMarkup(<OtpVerification {...props} />);
  const challenged = renderToStaticMarkup(<OtpVerification {...props} challengeId="synthetic-challenge" />);
  expect(idle).toContain('Send Verification Code');
  expect(idle).toContain('Remove Phone Number');
  expect(challenged).toContain('Verify Code');
  expect(challenged).not.toContain('Remove Phone Number');
});

test('retained task presentation keeps ordered statuses and nullable dates', () => {
  expect(Object.values(STATUS_META).map((status) => status.order)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(fullDate(null)).toBe('');
  expect(fullDate('2026-01-01T12:00:00Z')).toBe(new Date('2026-01-01T12:00:00Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }));
});

/* ─── KRTX-4727: the arc blur moves onto the wrapper's motion keyframes,
     and KortixGrid's seeded fill memo stops re-running every render. ──── */

// Capture every `m.div` prop object so the test can assert the wrapper's
// `animate` config without a DOM.
const wrapperProps: Array<Record<string, unknown>> = [];
// Capture every useMemo return so the grid test can assert the memo returns
// the same array across renders.
const memoReturns: Array<unknown> = [];

const realReact = await import('react');
// Capture the hook by value before mocking: bun's mock.module patches the
// live module namespace, so a wrapper that reads `realReact.useMemo` after
// the mock would recurse into itself.
const realUseMemo = realReact.useMemo;
const motionStub: Record<string, (props: Record<string, unknown>) => unknown> = {
  div: (props) => (wrapperProps.push(props), props.children ?? null),
};
mock.module('motion/react', () => ({
  m: new Proxy(motionStub, { get: (stub, el: string) => stub[el] ?? stub.div }),
  useMotionValue: () => ({ on: () => () => {}, set: () => {} }),
  useTransform: () => ({ on: () => () => {} }),
}));
mock.module('react', () => ({
  ...realReact,
  useMemo: (factory: () => unknown, deps: Parameters<typeof realUseMemo>[1]) => {
    const value = realUseMemo(factory, deps);
    memoReturns.push(value);
    return value;
  },
}));
// Gridder's decorative per-letter animation is not under test.
mock.module('./hyper-text', () => ({ HyperText: () => null }));

// Import after the mocks so the module under test resolves through them (the
// static import above ran with real motion, before the mocks were installed).
const { AnimatedBg: AnimatedBgFresh } = await import('./animated-bg');
const KortixGrid = (await import('./marketing/gridder')).default;

beforeEach(() => {
  wrapperProps.length = 0;
  memoReturns.length = 0;
});

test('arc blur keyframes on the wrapper drive the configured stops in order', () => {
  act(() => {
    create(<AnimatedBgFresh />);
  });
  act(() => {});

  // Hero variant: two left arcs, then two right arcs.
  expect(wrapperProps.length).toBe(4);
  const first = wrapperProps[0];
  expect((first.transition as { times: number[] }).times).toEqual([0, 0.33, 0.66, 1]);
  expect((first.animate as { filter: string[] }).filter).toEqual([
    'blur(19px)',
    'blur(500px)',
    'blur(50px)',
    'blur(500px)',
  ]);
  for (const props of wrapperProps) {
    expect((props.animate as { filter: string[] }).filter?.length).toBe(4);
  }
});

test('KortixGrid keeps the same grid items array across renders with the same props', () => {
  let renderer: ReturnType<typeof create> | null = null;
  act(() => {
    renderer = create(<KortixGrid />);
  });
  act(() => {
    renderer?.update(<KortixGrid />);
  });

  expect(memoReturns.length).toBe(2);
  expect(memoReturns[1]).toBe(memoReturns[0]);
});
