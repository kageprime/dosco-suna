/**
 * Settings → Instances (app/(settings)/instances.tsx): one row per instance,
 * its status dot and label from the status set. running/ready/active,
 * stopped, archived and error/failed are settled; any other status is still
 * provisioning: an orange dot, "Provisioning...", the row disabled, and the
 * list polled every 5 s. Real: the screen and the theme. Every other import
 * is a stub.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestInstance, type ReactTestRenderer, act, create } from 'react-test-renderer';

import type { SandboxInfo } from '@/lib/platform/client';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;

let colorScheme: 'light' | 'dark' = 'light';
let instances: SandboxInfo[] = [];

mock.module('react-native', () => ({
  Alert: { alert: none },
  Pressable: host('pressable'),
  RefreshControl: none,
  ScrollView: host('scroll'),
  View: host('view'),
}));
// theme.ts spreads these; the real barrel loads react-native, which Bun cannot parse.
mock.module('expo-router/react-navigation', () => ({
  DarkTheme: { colors: {} },
  DefaultTheme: { colors: {} },
}));
mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme }) }));
mock.module('@/lib/haptics', () => ({
  haptics: { medium: none, tap: none, success: none, warning: none },
}));
mock.module('@/components/kortix/sheet-parts', () => ({
  SheetRawTextInput: none,
  SheetView: host('sheet-view'),
}));
mock.module('@/lib/icons', () => ({
  CheckIcon: none,
  GlobeIcon: none,
  MonitorIcon: none,
  PlusIcon: none,
  HardDrivesIcon: none,
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: none }));
mock.module('@/components/ui/icon', () => ({ Icon: none }));
mock.module('@/contexts/SandboxContext', () => ({
  useSandboxContext: () => ({ sandboxId: 'ext-running', switchSandbox: none }),
}));
mock.module('@/lib/platform/hooks', () => ({
  useInstances: () => ({ data: instances, isLoading: false, refetch: none, isRefetching: false }),
}));
mock.module('@/lib/platform/client', () => ({ checkInstanceHealth: async () => null }));
mock.module('@/stores/instance-progress', () => ({
  setInstanceProgress: none,
  useInstanceProgress: () => null,
}));
mock.module('@/lib/theme-colors', () => ({
  useThemeColors: () => ({ primary: 'primary', primaryForeground: 'primary-foreground' }),
}));
mock.module('@/hooks/useSandboxUpdate', () => ({
  useGlobalSandboxUpdate: () => ({ currentVersion: null }),
}));
mock.module('@/components/kortix/sheet', () => ({
  SheetBackdrop: none,
  KortixBottomSheetModal: React.forwardRef<unknown, { children?: React.ReactNode }>(function Sheet(
    { children },
    _ref,
  ) {
    return React.createElement('sheet', null, children);
  }),
}));
mock.module('@/components/kortix/toast-provider', () => ({ useToast: () => ({ error: none }) }));

const instance = (status: string): SandboxInfo => ({
  sandbox_id: `sb-${status}`,
  external_id: `ext-${status}`,
  name: `Box ${status}`,
  provider: 'daytona',
  base_url: 'http://sandbox.test',
  status,
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z',
});

let InstancesScreen: typeof import('../../app/(settings)/instances').default;
let THEME: typeof import('@/lib/utils/theme').THEME;
const realSetInterval = globalThis.setInterval;
const polls: number[] = [];
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ default: InstancesScreen } = await import('../../app/(settings)/instances'));
  ({ THEME } = await import('@/lib/utils/theme'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  globalThis.setInterval = realSetInterval;
  polls.length = 0;
  colorScheme = 'light';
  instances = [];
});

function render(statuses: string[]) {
  instances = statuses.map(instance);
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    polls.push(ms ?? 0);
    return realSetInterval(handler, 60_000);
  }) as typeof setInterval;
  act(() => {
    tree = create(<InstancesScreen />);
  });
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');

/** Each instance row as it renders: dot colour, status label, pressable or not. */
const rows = () =>
  (
    tree?.root.findAll(
      (n) => String(n.type) === 'pressable' && typeof n.props.disabled === 'boolean',
    ) ?? []
  ).map((row) => ({
    dot: row.find((n) => n.type === 'view' && String(n.props.className).includes('h-2.5 w-2.5'))
      .props.style.backgroundColor,
    label: textOf(
      row.find((n) => n.type === 'text' && String(n.props.className).startsWith('mt-0.5')),
    ),
    disabled: row.props.disabled,
  }));

describe('the status set behind each instance row', () => {
  test('every settled status has its colour and label; the row can be selected', () => {
    render(['running', 'ready', 'active', 'stopped', 'archived', 'error', 'failed']);
    expect(rows()).toEqual([
      { dot: THEME.accent.light.green, label: 'Connected · DAYTONA', disabled: false },
      { dot: THEME.accent.light.green, label: 'Connected · DAYTONA', disabled: false },
      { dot: THEME.accent.light.green, label: 'Connected · DAYTONA', disabled: false },
      { dot: THEME.light.mutedForeground, label: 'Stopped · DAYTONA', disabled: false },
      { dot: THEME.light.mutedForeground, label: 'Archived · DAYTONA', disabled: false },
      { dot: THEME.light.destructive, label: 'Error · DAYTONA', disabled: false },
      { dot: THEME.light.destructive, label: 'Error · DAYTONA', disabled: false },
    ]);
    expect(polls).toEqual([]);
  });

  test('the dark theme takes the dark accent, muted and destructive colours', () => {
    colorScheme = 'dark';
    render(['running', 'stopped', 'failed']);
    expect(rows().map((row) => row.dot)).toEqual([
      THEME.accent.dark.green,
      THEME.dark.mutedForeground,
      THEME.dark.destructive,
    ]);
  });

  test('any other status is provisioning: orange, disabled, and the list polls every 5 s', () => {
    render(['running', 'creating', '']);
    expect(rows()).toEqual([
      { dot: THEME.accent.light.green, label: 'Connected · DAYTONA', disabled: false },
      { dot: THEME.accent.light.orange, label: 'Provisioning... · DAYTONA', disabled: true },
      { dot: THEME.accent.light.orange, label: 'Provisioning... · DAYTONA', disabled: true },
    ]);
    expect(polls).toEqual([5000]);
  });
});
