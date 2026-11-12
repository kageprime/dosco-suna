import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// PromptPreview characterization (KRTX-4790): the read-only tile (no `onEdit`)
// is plain text on the tile surface with no press target and no caret; with
// `onEdit` the row is a button that haptic-taps and opens the editor. The tile
// surface `rounded-2xl bg-secondary` renders exactly once per mode — the
// FLATTEN collapses the duplicated label + tile into one of each.
// Real: the component. Every import is a stub.

const source = readFileSync(`${import.meta.dir}/TriggerPromptField.tsx`, 'utf8');
const host = (name: string) => (props: any) => React.createElement(name, props);
const Empty = () => null;

let taps = 0;
let opens = 0;
const CaretRightIcon = 'CaretRightIcon';

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View'), Pressable: host('Pressable') },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@/components/kortix/sheet-parts': { SheetScrollView: Empty },
  '@/components/kortix/SheetInput': { SheetTextInput: Empty },
  '@/components/kortix/sheet': { SheetTitleRow: Empty },
  '@/components/kortix/sheet-push': { SheetBackButton: Empty },
  '@/components/ui/button': { Button: host('Button') },
  '@/components/ui/icon': { Icon: host('Icon') },
  '@/components/ui/text': { Text: host('Text') },
  '@/lib/haptics': { haptics: { tap() { taps++; }, success() {}, selection() {}, medium() {} } },
  '@/lib/icons': { CaretRightIcon },
};
const stubs: Record<string, Record<string, unknown>> = {};
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  const values = (stubs[name] ??= { ...fakes[name] });
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
}
for (const [name, values] of Object.entries(stubs)) mock.module(name, () => values);

let PromptPreview: typeof import('./TriggerPromptField').PromptPreview;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ PromptPreview } = await import('./TriggerPromptField'));
});

let tree: any;
function render(value: string, edit?: () => void) {
  taps = 0;
  opens = 0;
  act(() => {
    tree = create(<PromptPreview value={value} onEdit={edit} />);
  });
}
const tileClassName = 'rounded-2xl bg-secondary';
/** The rendered element tree, as one string. */
const rendered = () => JSON.stringify(tree.toJSON());
/** Nodes painted on the tile surface: the read-only View, or the editable Pressable row. */
const tileViews = () =>
  tree.root.findAll(
    (node: any) =>
      (node.type === 'View' || node.type === 'Pressable') &&
      typeof node.props.className === 'string' &&
      node.props.className.includes(tileClassName),
  );
/** Texts whose content includes `text`. */
const texts = (text: string) =>
  tree.root.findAll((node: any) => node.type === 'Text' && node.children.some((c: any) => String(c).includes(text)));

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

describe('PromptPreview', () => {
  test('without onEdit: the tile is plain text, no press target, no caret', () => {
    render('  hello prompt  ');
    expect(tileViews()).toHaveLength(1);
    expect(texts('hello prompt')).toHaveLength(1); // the value, trimmed
    expect(texts('Prompt')).toHaveLength(1); // one label
    expect(tree.root.findAll((node: any) => node.type === 'Pressable')).toHaveLength(0);
    expect(tree.root.findAll((node: any) => node.type === 'Icon')).toHaveLength(0);
  });

  test('with onEdit: the row is a button with a caret; a press haptic-taps and opens the editor', () => {
    render('hello prompt', () => {
      opens++;
    });
    expect(tileViews()).toHaveLength(1); // the tile surface renders exactly once, on the Pressable row
    expect(texts('Prompt')).toHaveLength(1); // one label
    const pressable = tree.root.findAll((node: any) => node.type === 'Pressable')[0];
    expect(pressable.props.accessibilityRole).toBe('button');
    expect(pressable.props.accessibilityLabel).toBe('Edit prompt');
    expect(pressable.props.className).toContain(tileClassName);
    const icon = tree.root.findAll((node: any) => node.type === 'Icon')[0];
    expect(icon.props.as).toBe(CaretRightIcon);
    expect(taps).toBe(0);
    act(() => pressable.props.onPress());
    expect(taps).toBe(1);
    expect(opens).toBe(1); // the editor opened
  });
});
