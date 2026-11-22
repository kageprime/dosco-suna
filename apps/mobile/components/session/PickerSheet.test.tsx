import { expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Props = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => {
  function Host({ children, ...props }: Props) {
    return React.createElement(name, props, children);
  }
  Host.displayName = name;
  return Host;
};
mock.module('react-native', () => ({
  View: host('view'),
  useWindowDimensions: () => ({ height: 800 }),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34 }),
}));
mock.module('@/components/kortix/sheet', () => ({
  KortixBottomSheetModal: host('modal'),
  useSheetHandle: () => ({ current: { dismiss: mock() } }),
  useSheetBackground: () => 'background',
  useCloseThen: () => ({ deferAfterClose: mock(), takeAfterClose: () => undefined }),
}));
mock.module('@/components/kortix/sheet-parts', () => ({ SheetScrollView: host('scroll') }));
mock.module('@/components/kortix/SheetInput', () => ({ SheetTextInput: host('input') }));
mock.module('@/components/kortix/settings-list', () => ({
  SettingsGroup: host('group'),
  SettingsRow: host('row'),
}));
mock.module('@/components/kortix/pinned-bar', () => ({
  PinnedBar: host('bar'),
  usePinnedBarInset: () => 126,
}));
mock.module('@/components/navigation/FloatingTabBar', () => ({ FloatingTabCapsule: host('tabs') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/lib/haptics', () => ({ haptics: { selection: mock(), tap: mock() } }));
const { PickerSheet } = await import('./PickerSheet');

test('the tabbed picker keeps a full-height scrolling list and selects the final row', async () => {
  const onSelect = mock();
  const onTab = mock();
  const options = Array.from({ length: 40 }, (_, i) => ({
    key: `model-${i}`,
    label: `Model ${i}`,
  }));
  const rendered: { tree?: ReactTestRenderer } = {};
  await act(async () => {
    rendered.tree = create(
      <PickerSheet
        title="Model"
        options={options}
        activeKey="model-0"
        onSelect={onSelect}
        searchLabel="Search models"
        emptyLabel="No matching models"
        closeOnSelect={false}
        tabs={{ items: [], activeIndex: 1, onSelect: onTab }}
      />,
    );
  });
  const { tree } = rendered;
  if (!tree) throw new Error('PickerSheet did not render');
  const modal = tree.root.find((node: { type: unknown }) => node.type === 'modal');
  expect(modal.props.snapPoints).toEqual(['100%']);
  expect(modal.props.enableDynamicSizing).toBe(false);
  const scroll = tree.root.find((node: { type: unknown }) => node.type === 'scroll');
  expect(scroll.props.style).toEqual({ flex: 1 });
  expect(scroll.props.contentContainerStyle.paddingBottom).toBe(126);
  const rows = tree.root.findAll((node: { type: unknown }) => node.type === 'row');
  expect(rows).toHaveLength(40);
  await act(async () => rows[39].props.onPress());
  expect(onSelect).toHaveBeenCalledWith('model-39');
  await act(async () =>
    tree.root.find((node: { type: unknown }) => node.type === 'tabs').props.onSelect(0),
  );
  expect(onTab).toHaveBeenCalledWith(0);
  await act(async () => tree.unmount());
});
