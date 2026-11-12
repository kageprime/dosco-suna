/**
 * GlassButtons off glass (Android, iOS before 26): a `shared` group stays one
 * row, so its buttons never stack in a column slot (the workspace switcher's
 * gear and plus in the sheet title row).
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

mock.module('react-native', () => ({
  Platform: { OS: 'android', Version: 35 },
  StyleSheet: { absoluteFill: {} },
  View: host('view'),
}));
mock.module('expo', () => ({ requireOptionalNativeModule: () => null }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));

let GlassButtons: typeof import('./liquid-glass').GlassButtons;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ GlassButtons } = await import('./liquid-glass'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

const render = (el: React.ReactElement) => {
  act(() => {
    tree = create(el);
  });
  return tree!.toJSON() as unknown;
};

describe('GlassButtons without Liquid Glass', () => {
  test('a shared group renders its buttons in one row', () => {
    const json = render(
      <GlassButtons shared>
        {React.createElement('button-a')}
        {React.createElement('button-b')}
      </GlassButtons>,
    ) as { type: string; props: { style: { flexDirection: string } }; children: Array<{ type: string }> };
    expect(json.type).toBe('view');
    expect(json.props.style.flexDirection).toBe('row');
    expect(json.children.map((c) => c.type)).toEqual(['button-a', 'button-b']);
  });

  test('an unshared group adds no wrapper', () => {
    const json = render(
      <GlassButtons>{React.createElement('button-a')}</GlassButtons>,
    ) as { type: string };
    expect(json.type).toBe('button-a');
  });
});

