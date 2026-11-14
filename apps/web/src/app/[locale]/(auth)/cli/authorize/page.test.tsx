import { expect, mock, test } from 'bun:test';
import { createElement, forwardRef, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `/cli/authorize` for a device sign-in (`?user_code=…`): which screen the
 * workspace list state produces.
 *
 * KRTX-4788: a FAILED list (`GET /v1/workspaces` errors) is unknown, not
 * empty — the page must offer a retry, never tell a person whose workspaces
 * it could not see to create one. A truly empty list keeps the
 * create-workspace screen, and a loaded list keeps the approve form.
 */

type DirectoryState = {
  loading?: boolean;
  failed?: boolean;
  openable?: Array<{ workspaceId: string; accountId: string; project: { name: string } }>;
};

let directory: DirectoryState = {};
let retries = 0;

function directoryMock() {
  return {
    accounts: [],
    workspaces: directory.openable ?? [],
    openable: directory.openable ?? [],
    loading: directory.loading ?? false,
    failedAccountIds: directory.failed ? ['workspaces'] : [],
    reusableAccount: null,
    githubSourceAccount: null,
    retryFailed: () => {
      retries += 1;
    },
  };
}

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('user_code=B2F294D0F2EBD017'),
  useParams: () => ({}),
  usePathname: () => '/cli/authorize',
}));
mock.module('next/link', () => ({
  default: (props: { href: string; children?: ReactNode }) =>
    createElement('a', { href: props.href }, props.children),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'pr-demo@example.test' },
    isLoading: false,
  }),
}));
mock.module('@kortix/ui/workspace/sidebar/use-workspace-directory', () => ({
  useWorkspaceDirectory: directoryMock,
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
mock.module('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: motionComponents,
  animate: () => Promise.resolve(),
  useMotionValue: (initial: number) => ({
    get: () => initial,
    set: () => {},
    on: () => () => {},
    addEventListener: () => () => {},
    hasListeners: () => false,
    remove: () => {},
    destroy: () => {},
  }),
  useReducedMotion: () => true,
}));

const { default: CliAuthorizePage } = await import('./page');

function renderPage(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(CliAuthorizePage));
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer): string {
  const collect = (node: ReactTestInstance): string =>
    (node.children ?? [])
      .map((child) => (typeof child === 'string' ? child : collect(child as ReactTestInstance)))
      .join(' ');
  return collect(renderer.root);
}

/** The button whose label contains `text`, or null when none is rendered. */
function findButtonWithText(renderer: ReactTestRenderer, text: string): ReactTestInstance | null {
  return (
    renderer.root.findAll(
      (node) =>
        node.type === 'button' &&
        node.children.some((child) => typeof child === 'string' && child.includes(text)),
    )[0] ?? null
  );
}

const ONE_WORKSPACE = [
  { workspaceId: 'ws-1', accountId: 'acc-1', project: { name: 'Solo Workspace' } },
];

test('a failed workspace list is a retry, never the create-workspace dead end', () => {
  directory = { failed: true, loading: false, openable: [] };
  const renderer = renderPage();
  const text = textOf(renderer);
  expect(text).toContain("Couldn't load your workspaces");
  expect(text).not.toContain('Create a workspace to sign in the CLI');
  expect(text).not.toContain('Create workspace');
  expect(findButtonWithText(renderer, 'Try again')).not.toBeNull();
});

test('the retry button asks the directory to refetch', () => {
  directory = { failed: true, loading: false, openable: [] };
  const renderer = renderPage();
  retries = 0;
  const button = findButtonWithText(renderer, 'Try again');
  expect(button).not.toBeNull();
  act(() => {
    button!.props.onClick();
  });
  expect(retries).toBe(1);
});

test('a loaded empty list keeps the create-workspace screen', () => {
  directory = { failed: false, loading: false, openable: [] };
  const renderer = renderPage();
  const text = textOf(renderer);
  expect(text).toContain('Create a workspace to sign in the CLI');
  expect(text).toContain('The CLI signs in to a workspace');
  expect(findButtonWithText(renderer, 'Try again')).toBeNull();
});

test('a loaded list with a workspace keeps the approve form', () => {
  directory = { failed: false, loading: false, openable: ONE_WORKSPACE };
  const renderer = renderPage();
  const text = textOf(renderer);
  expect(text).toContain('Authorize Kortix CLI');
  expect(text).toContain('Login code');
  expect(findButtonWithText(renderer, 'Try again')).toBeNull();
});
