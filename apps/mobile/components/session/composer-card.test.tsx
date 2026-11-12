/**
 * Characterization: the floating composer surfaces draw the composer card and
 * the one capped list. The question card (`QuestionPrompt`) and the suggestion
 * card (`SuggestionCard`, MentionSuggestions) draw the same card surface and
 * the same 260pt scroll cap; the status pill draws the same card as its row.
 * The assertions pass before and after the shared `ComposerCard` /
 * `ComposerPopover` extraction, so the restructure cannot drift the chrome.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).__DEV__ = true;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;

mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  View: host('view'),
  Animated: { View: host('animated-view') },
  TextInput: host('text-input'),
  ScrollView: host('scroll-view'),
  StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
}));
mock.module('expo', () => ({ requireOptionalNativeModule: () => null }));
mock.module('expo-blur', () => ({ BlurView: host('blur') }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
const entering = { duration: () => entering, easing: () => entering, build: () => ({}) } as never;
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  Easing: { out: (f: unknown) => f, quad: (f: unknown) => f },
  FadeIn: entering,
  FadeOut: entering,
  LayoutAnimationConfig: ({ children }: HostProps) => children,
}));
mock.module('@/lib/icons', () => ({
  ArrowUpIcon: host('icon-arrow-up'),
  CaretDownIcon: host('icon-caret-down'),
  CheckIcon: host('icon-check'),
  ChatIcon: host('icon-chat'),
  FolderIcon: host('icon-folder'),
  MicrophoneIcon: host('icon-microphone'),
  PlusIcon: host('icon-plus'),
  RobotIcon: host('icon-robot'),
  SparkleIcon: host('icon-sparkle'),
  XIcon: host('icon-x'),
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: ({ as, ...props }: HostProps & { as?: unknown }) => React.createElement('icon', props) }));
mock.module('@/components/ui/text', () => ({ Text: host('text'), TextClassContext: React.Fragment }));
mock.module('@/components/kortix/pill-input', () => ({ INPUT_FONT_FAMILY: 'roobert', INPUT_FONT_SIZE: 16, PillInput: host('pill-input') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
mock.module('@/components/kortix/dictation-waveform', () => ({ DictationWaveform: host('waveform') }));
mock.module('@/components/kortix/StopIcon', () => ({ StopIcon: host('icon-stop') }));
mock.module('@/components/session/composer-attachment-tiles', () => ({ ComposerAttachmentTiles: none }));
mock.module('@/hooks/useDictation', () => ({
  useDictation: () => ({
    active: false,
    state: 'idle',
    levels: [] as number[],
    start: () => {},
    cancel: () => {},
    finish: () => {},
  }),
}));
// The theme lives behind the expo-router barrel bun cannot parse; the question
// behavior under test does not depend on the palette's values.
mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { secondary: '#eee', popover: '#fff', mutedForeground: '#666', background: '#fff', border: '#ddd' },
    dark: { secondary: '#111', popover: '#000', mutedForeground: '#999', background: '#000', border: '#222' },
  },
  withAlpha: (c: string, a: number) => `${c}@${a}`,
}));
mock.module('@/lib/utils/tone', () => ({ useTone: () => 'light' as const }));
mock.module('@/components/kortix/pressable-surface', () => ({
  // Pass the onPress through so tests can tap option rows and controls.
  PressableSurface: ({ children, onPress, ...rest }: HostProps) =>
    React.createElement('pressable-surface', { ...rest, onPress }, children),
}));
mock.module('@/components/files/file-icons', () => ({ fileIcon: () => 'icon-file' }));
mock.module('@/lib/ui/font-scale', () => ({ BUTTON_LABEL_MAX_FONT_SCALE: 1.4 }));

/** The composer card's surface, the one definition (`components/kortix/composer.tsx`). */
const COMPOSER_CARD_CLASS = 'rounded-3xl border border-border bg-background p-2';
/** The card surface's tokens without the composer's `p-2` inset. */
const CARD_SURFACE_TOKENS = ['rounded-3xl', 'border', 'border-border', 'bg-background'];

let QuestionPrompt: typeof import('./QuestionPrompt').QuestionPrompt;
let MentionSuggestions: typeof import('./MentionSuggestions').MentionSuggestions;
let ComposerStatusPill: typeof import('./ComposerStatusPill').ComposerStatusPill;
beforeAll(async () => {
  ({ QuestionPrompt } = await import('./QuestionPrompt'));
  ({ MentionSuggestions } = await import('./MentionSuggestions'));
  ({ ComposerStatusPill } = await import('./ComposerStatusPill'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

const render = async (element: React.ReactElement) => {
  await act(async () => {
    tree = create(element);
  });
  return tree!;
};

const views = (root: ReactTestRenderer) => root.root.findAll(({ type }: ReactTestInstance) => type === 'view') as ReactTestInstance[];
const scrollViews = (root: ReactTestRenderer) =>
  root.root.findAll(({ type }: { type: unknown }) => type === 'scroll-view') as ReactTestInstance[];
const classTokens = (node: ReactTestInstance) => String(node.props.className ?? '').split(' ');

const request = {
  id: 'q1',
  questions: [
    {
      question: 'Which shell?',
      header: 'shell',
      options: [
        { label: 'zsh', description: 'Z shell' },
        { label: 'fish', description: 'Friendly shell' },
      ],
    },
  ],
} as never;

describe('the floating composer surfaces draw the composer card', () => {
  test('the question card draws the composer card and its capped option list', async () => {
    await render(React.createElement(QuestionPrompt, { request, onReply: () => {}, onReject: () => {} }));
    const card = views(tree!).find((node) => node.props.className === COMPOSER_CARD_CLASS);
    expect(card).toBeDefined();
    // The option list is the one capped scroll: about five rows, then it scrolls.
    const list = scrollViews(tree!);
    expect(list).toHaveLength(1);
    expect(list[0].props.style).toMatchObject({ maxHeight: 260 });
    expect(list[0].props.showsVerticalScrollIndicator).toBe(false);
    expect(list[0].props.keyboardShouldPersistTaps).toBe('handled');
  });

  test('the suggestion card draws the composer card and the same capped list', async () => {
    await render(
      React.createElement(MentionSuggestions, {
        items: [{ kind: 'agent', label: 'Deploy bot', value: 'deploy-bot' }] as never[],
        selectedIndex: 0,
        onSelect: () => {},
      }),
    );
    const card = views(tree!).find((node) => {
      const tokens = classTokens(node);
      return tokens.length > 0 && CARD_SURFACE_TOKENS.every((t) => tokens.includes(t));
    });
    expect(card).toBeDefined();
    // The card floats on the composer's edge with a clip: its own outer margin.
    for (const t of ['mx-4', 'mb-2', 'overflow-hidden']) expect(classTokens(card!)).toContain(t);
    const list = scrollViews(tree!);
    expect(list).toHaveLength(1);
    expect(list[0].props.style).toMatchObject({ maxHeight: 260 });
    expect(list[0].props.showsVerticalScrollIndicator).toBe(false);
    expect(list[0].props.keyboardShouldPersistTaps).toBe('always');
  });

  test('the status pill draws the composer card as its row', async () => {
    await render(React.createElement(ComposerStatusPill, { dotColor: '#ea580c', label: 'Working' }));
    const card = views(tree!).find((node) => classTokens(node).includes('rounded-3xl') && classTokens(node).includes('bg-background'));
    expect(card).toBeDefined();
    for (const t of [...CARD_SURFACE_TOKENS, 'p-2', 'flex-row', 'items-center', 'gap-2']) expect(classTokens(card!)).toContain(t);
  });
});
