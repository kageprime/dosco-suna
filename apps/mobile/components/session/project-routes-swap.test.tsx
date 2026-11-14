import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';

// A drawer tap swaps the view in with no push slide: the route that pushes
// the view (project home) or replaces itself with it (a covering route)
// passes `swap=1` exactly when `takeDrawerSwap` says so. Real: ProjectRoutes
// and lib/session/project-stack. Stubbed: the navigator.

const dispatched: Array<{ type: string; name: string; params?: object }> = [];
const navigation = {
  dispatch: (action: { type: string; name: string; params?: object }) => dispatched.push(action),
  getState: () => ({ routes: [{ key: 'index-1', name: 'index' }] }),
  addListener: () => () => {},
  goBack() {},
};
mock.module('expo-router/react-navigation', () => ({
  useNavigation: () => navigation,
  useIsFocused: () => true,
  useRoute: () => ({ key: 'r-1' }),
  StackActions: {
    push: (name: string, params?: object) => ({ type: 'push', name, params }),
    replace: (name: string, params?: object) => ({ type: 'replace', name, params }),
    popTo: (name: string, params?: object) => ({ type: 'popTo', name, params }),
  },
  CommonActions: { reset: (state: object) => ({ type: 'reset', name: '', params: state }) },
}));
mock.module('expo-router', () => ({ useLocalSearchParams: () => ({}) }));
mock.module('@/lib/haptics', () => ({ haptics: { tap() {} } }));

let Routes: typeof import('./ProjectRoutes');
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Routes = await import('./ProjectRoutes');
});

let tree: any;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
  dispatched.length = 0;
});

const value = (swap: boolean) => {
  let pending = swap;
  return {
    home: null,
    view: null,
    isHome: false,
    viewKey: 'page:page:review',
    homeKey: 0,
    goHome() {},
    newSession() {},
    onViewCovered() {},
    projectId: 'p-1',
    openProjectSession() {},
    openDrawer() {},
    isDrawerOpen: false,
    // Read once, like ProjectScreen's.
    takeDrawerSwap: () => {
      const result = pending;
      pending = false;
      return result;
    },
    openSessionActions() {},
    openSubPage() {},
    renderSubPage: () => null,
  } as unknown as import('./ProjectRoutes').ProjectRouteValue;
};

function CoveringRoute() {
  Routes.useCoveringRoute();
  return null;
}

const mount = async (element: React.ReactElement, swap: boolean) => {
  await act(async () => {
    tree = create(React.createElement(Routes.ProjectRouteProvider, { value: value(swap) }, element));
  });
};

describe('the view swaps in only after a drawer tap', () => {
  test('project home pushes the view with swap=1 after a drawer tap', async () => {
    await mount(React.createElement(Routes.ProjectHomeRoute), true);
    expect(dispatched).toEqual([{ type: 'push', name: 'view', params: { swap: '1' } }]);
  });

  test('project home pushes the view with the slide otherwise (a composer send)', async () => {
    await mount(React.createElement(Routes.ProjectHomeRoute), false);
    expect(dispatched).toEqual([{ type: 'push', name: 'view', params: undefined }]);
  });

  test('a covering route replaces itself with the view, swap=1 after a drawer tap', async () => {
    await mount(React.createElement(CoveringRoute), true);
    expect(dispatched).toEqual([{ type: 'replace', name: 'view', params: { swap: '1' } }]);
  });

  test('a covering route replaces itself with the slide otherwise (a notification)', async () => {
    await mount(React.createElement(CoveringRoute), false);
    expect(dispatched).toEqual([{ type: 'replace', name: 'view', params: undefined }]);
  });
});
