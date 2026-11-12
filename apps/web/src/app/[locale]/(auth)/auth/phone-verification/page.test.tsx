import { expect, mock, test } from 'bun:test';
import { createElement, forwardRef, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * Characterization for `/auth/phone-verification` (KRTX-4721): the enroll →
 * challenge → OTP transition is pinned BEFORE the dedupe collapses the three
 * create-challenge blocks into one `startChallenge`. The assertions must read
 * the same before and after; no expectation changes.
 */

const calls = {
  enroll: [] as unknown[],
  challenge: [] as unknown[],
  verify: [] as unknown[],
  unenroll: [] as string[],
  toasts: [] as string[],
};

// The two child forms are stubs that surface the callbacks the page hands
// them: the page's contract is which props it passes and which state it
// drives, so the transition renders as labelled buttons.
mock.module('@/features/auth/phone-verification/phone-input', () => ({
  PhoneInput: ({ onSubmit, isLoading }: { onSubmit: (phone: string) => Promise<void>; isLoading?: boolean }) =>
    createElement(
      'div',
      null,
      createElement(
        'button',
        { 'data-testid': 'phone-submit', disabled: isLoading, onClick: () => void onSubmit('+15551234567') },
        'phone-submit-stub',
      ),
    ),
}));
mock.module('@/features/auth/phone-verification/otp-verification', () => ({
  OtpVerification: (props: {
    phoneNumber?: string;
    challengeId?: string;
    onVerify: (otp: string) => Promise<void>;
    onResend: () => Promise<void>;
    onSendCode?: () => Promise<void>;
    onRemovePhone?: () => Promise<void>;
  }) =>
    createElement(
      'div',
      null,
      createElement('p', { 'data-testid': 'otp-phone' }, props.phoneNumber),
      createElement('p', { 'data-testid': 'otp-challenge' }, props.challengeId),
      createElement(
        'button',
        { 'data-testid': 'otp-verify', onClick: () => void props.onVerify('123456') },
        'otp-verify-stub',
      ),
      createElement(
        'button',
        { 'data-testid': 'otp-resend', onClick: () => void props.onResend() },
        'otp-resend-stub',
      ),
      props.onSendCode
        ? createElement(
            'button',
            { 'data-testid': 'otp-send', onClick: () => void props.onSendCode?.() },
            'otp-send-stub',
          )
        : null,
      props.onRemovePhone
        ? createElement(
            'button',
            { 'data-testid': 'otp-remove', onClick: () => void props.onRemovePhone?.() },
            'otp-remove-stub',
          )
        : null,
    ),
}));

// The service the hooks call: fresh per test via `reset()`.
const reset = () => {
  calls.enroll.length = 0;
  calls.challenge.length = 0;
  calls.verify.length = 0;
  calls.unenroll.length = 0;
  calls.toasts.length = 0;
};
let existingFactors: { id: string; factor_type: string; status: string; phone?: string }[] = [];
mock.module('@/lib/supabase/mfa', () => ({
  supabaseMFAService: {
    enrollPhoneNumber: async (data: { friendly_name: string; phone_number: string }) => {
      calls.enroll.push(data);
      return { id: 'factor-1', friendly_name: data.friendly_name, phone_number: data.phone_number };
    },
    createChallenge: async (data: { factor_id: string }) => {
      calls.challenge.push(data);
      return { id: `challenge-${calls.challenge.length}` };
    },
    verifyChallenge: async (data: { factor_id: string; challenge_id: string; code: string }) => {
      calls.verify.push(data);
      return {};
    },
    listFactors: async () => ({ factors: existingFactors }),
    unenrollFactor: async (factorId: string) => {
      calls.unenroll.push(factorId);
      return {};
    },
    getAAL: async () => ({}),
  },
  // use-mfa.ts (now imported by the page) reads this pure helper from the
  // same module.
  mfaChallengeRequired: () => false,
}));
mock.module('@/lib/auth/perform-sign-out', () => ({ performSignOut: async () => {} }));
mock.module('@kortix/ui/internal/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/projects' }));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, isLoading: false }),
}));
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => '/auth/phone-verification',
}));
mock.module('@kortix/ui/toast', () => ({
  errorToast: (message: string) => {
    calls.toasts.push(message);
  },
  successToast: () => {},
}));

// motion/react with no DOM: render the same tag with the animation-only props
// stripped, and always claim reduced motion so no animation timing runs.
const MOTION_ONLY_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileInView',
  'viewport',
  'layout',
  'layoutId',
]);
const motionComponents = new Proxy(
  {},
  {
    get: (_target, tag: string) =>
      forwardRef(function MotionStub(motionProps: Record<string, unknown>, ref) {
        const domProps = Object.fromEntries(
          Object.entries(motionProps).filter(([key]) => !MOTION_ONLY_PROPS.has(key)),
        );
        return createElement(tag, { ...domProps, ref });
      }),
  },
);
const realMotion = await import('motion/react');
mock.module('motion/react', () => ({
  ...realMotion,
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: motionComponents,
  animate: () => Promise.resolve(),
  useReducedMotion: () => true,
}));

const { default: PhoneVerificationPage } = await import('./page');

async function render(): Promise<ReactTestRenderer> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client }, createElement(PhoneVerificationPage)),
    );
  });
  // One flush for the factors query answer and the mount effect it drives
  // (react-query notifies on its own scheduler, past one microtask).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return renderer;
}

/** Every text leaf of the rendered tree, joined. */
function textOf(renderer: ReactTestRenderer): string {
  let out = '';
  const walk = (node: ReactTestInstance | string | number) => {
    if (typeof node === 'string' || typeof node === 'number') {
      out += `${node}`;
      return;
    }
    for (const child of node.children) walk(child as ReactTestInstance);
  };
  walk(renderer.root);
  return out;
}

function byTestId(renderer: ReactTestRenderer, id: string): ReactTestInstance {
  const hits = renderer.root.findAll((node) => node.props['data-testid'] === id);
  if (hits.length === 0) throw new Error(`no node ${id}`);
  return hits[0];
}

test('enroll creates a challenge and lands on the OTP step with the sent message', async () => {
  reset();
  existingFactors = [];
  const renderer = await render();
  expect(textOf(renderer)).toContain('Verify Your Phone Number');
  await act(async () => {
    byTestId(renderer, 'phone-submit').props.onClick();
  });
  expect(calls.enroll).toEqual([{ friendly_name: 'Primary Phone', phone_number: '+15551234567' }]);
  expect(calls.challenge).toEqual([{ factor_id: 'factor-1' }]);
  expect(textOf(renderer)).toContain('Enter Verification Code');
  expect(textOf(renderer)).toContain('Verification code sent to your phone');
  expect(textOf(renderer)).toContain('+15551234567');
  expect(textOf(renderer)).toContain('challenge-1');
  await act(async () => {
    renderer.unmount();
  });
});

test('a verified factor on mount lands on OTP; its send-code path challenges it', async () => {
  reset();
  existingFactors = [{ id: 'factor-9', factor_type: 'phone', status: 'verified', phone: '+15550001111' }];
  const renderer = await render();
  expect(textOf(renderer)).toContain('Enter Verification Code');
  expect(textOf(renderer)).toContain('+15550001111');
  await act(async () => {
    byTestId(renderer, 'otp-send').props.onClick();
  });
  expect(calls.challenge).toEqual([{ factor_id: 'factor-9' }]);
  expect(textOf(renderer)).toContain('Verification code sent to your phone');
  await act(async () => {
    renderer.unmount();
  });
});

test('resend challenges the same factor with the new-code message; verify succeeds', async () => {
  reset();
  existingFactors = [];
  const renderer = await render();
  await act(async () => {
    byTestId(renderer, 'phone-submit').props.onClick();
  });
  await act(async () => {
    byTestId(renderer, 'otp-resend').props.onClick();
  });
  expect(calls.challenge).toEqual([
    { factor_id: 'factor-1' },
    { factor_id: 'factor-1' },
  ]);
  expect(textOf(renderer)).toContain('New verification code sent');
  await act(async () => {
    byTestId(renderer, 'otp-verify').props.onClick();
  });
  // The verify reads the resent challenge, not the enroll one.
  expect(calls.verify).toEqual([{ factor_id: 'factor-1', challenge_id: 'challenge-2', code: '123456' }]);
  expect(textOf(renderer)).toContain('Phone number verified successfully!');
  await act(async () => {
    renderer.unmount();
  });
});
