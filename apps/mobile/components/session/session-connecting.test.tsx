import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const Empty = () => null;
mock.module('react-native', () => ({ View: Pass, ScrollView: Pass }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('@kortix/sdk/react', () => ({ useNow: () => 0 }));
mock.module('@/lib/icons', () => ({ ArrowCounterClockwiseIcon: Empty }));
mock.module('@/components/ui/text', () => ({ Text: Pass }));
mock.module('@/components/ui/button', () => ({ Button: Pass }));
mock.module('@/components/ui/icon', () => ({ Icon: Empty }));
mock.module('@/components/kortix/composer', () => ({ COMPOSER_CARD_CLASS: 'composer', Composer: Empty }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: Empty }));
mock.module('@/components/session/FloatingMenuButton', () => ({ FLOATING_MENU_CLEARANCE: 0 }));
mock.module('@/components/session/composer-bottom-fade', () => ({ ComposerBottomFade: Empty, composerSafeAreaPadding: () => 0 }));
mock.module('@/components/session/attachment-tile', () => ({ AttachmentTile: Empty }));
mock.module('@/components/session/turn/user-message', () => ({ MessageBody: Pass, UserMessageBubble: Pass }));
mock.module('@/components/session/SessionTurn', () => ({ SessionTurn: Empty }));
mock.module('@/components/session/dot-matrix/session-dot-matrix', () => ({ SessionDotMatrix: Empty }));
mock.module('@/components/session/tool/shared/navigation', () => ({ ToolFilePreviewHost: Empty, useToolFilePreviewStore: { getState: () => ({ openPreview() {} }) } }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { background: 'white', primaryForeground: 'white' }, dark: { background: 'black' }, accent: { light: { yellow: 'yellow' }, dark: { yellow: 'yellow' } } } }));
mock.module('@/lib/projects/hooks', () => ({ useSessionParticipants: () => ({}), useSessionMessageAuthors: () => ({}) }));

const { SessionConnecting } = await import('./SessionConnecting');
let tree: ReactTestRenderer | undefined;
const cancel = () => {};
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

async function render(props: React.ComponentProps<typeof SessionConnecting>) {
  await act(async () => { tree = create(<SessionConnecting {...props} />); });
  return tree;
}

test('a known empty conversation starts without an infrastructure notice', async () => {
  const openingSession = { empty: true, onCancel: cancel, statusLabel: "Waking this session’s computer" };
  const result = await render(openingSession);
  expect(JSON.stringify(result?.toJSON())).not.toContain('Waking');
  // A status card is extra chrome over the disabled composer.
  expect(result?.root.findAll((node) => node.props.accessibilityLiveRegion === 'polite')).toHaveLength(0);
});

test('a genuine start failure keeps its detail and working restart action', async () => {
  let restarts = 0;
  const result = await render({ onCancel: cancel, onRestart: () => restarts++, error: { title: 'Could not start session', message: 'Try again.', detail: 'Image build failed.' } });
  const text = JSON.stringify(result?.toJSON());
  expect(text).toContain('Image build failed.');
  expect(text).toContain('Restart session');
  const restart = result?.root.findAll((node) => node.type === Pass && node.props.variant === 'default')[0];
  expect(restart).toBeDefined();
  await act(async () => restart?.props.onPress());
  expect(restarts).toBe(1);
});
