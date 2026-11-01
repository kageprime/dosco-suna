import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function slot(tag: string, marker: string) {
  function Slot({ className, children, ...props }: { className?: string; children?: ReactNode; [key: string]: unknown }) {
    return createElement(tag, { className, 'data-slot': marker, ...props }, children);
  }
  return Slot;
}

mock.module('../../primitives/sidebar', () => ({
  SidebarMenuItem: slot('li', 'item'),
  SidebarMenuButton: slot('button', 'button'),
  SidebarMenuAction: slot('button', 'action'),
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
}));

const actualNav = await import('../../internal/layout/project-settings-nav');
mock.module('../../internal/layout/project-settings-nav', () => ({
  ...actualNav,
  CustomizeGlyph: () => createElement('span', null, 'glyph'),
  useCapabilityAccess: () => ({ settled: true, tabs: ['agent', 'models', 'config'] }),
}));

mock.module('../../internal/layout/project-capability-nav', () => ({
  isProjectAdminPath: () => false,
  ProjectCapabilityNav: () => createElement('div', { 'data-slot': 'capability-nav' }, 'Capability Nav'),
}));

const actualUi = await import('../../providers/ui-provider');
mock.module('../../providers/ui-provider', () => ({
  ...actualUi,
  useUiPathname: () => '/projects/p1/sessions/s1',
}));

const actualHooks = await import('../../internal/hooks');
mock.module('../../internal/hooks', () => ({
  ...actualHooks,
  useIsMobile: () => false,
}));

mock.module('../../i18n', () => ({
  useTranslations: () => (key: string) => key,
}));

const { ProjectNavItems } = await import('./project-nav-items');

describe('CustomizeNavEntry mobile & submenu disclosure', () => {
  test('renders customize button and submenu action button', () => {
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectNavItems, {
          projectId: 'p1',
        }),
      ),
    );

    expect(html).toContain('data-slot="action"');
    expect(html).toContain('Expand Customize submenu');
    expect(html).toContain('/projects/p1/settings');
  });

  test('renders submenu when on a customize/settings route', async () => {
    const queryClient = new QueryClient();
    mock.module('../../providers/ui-provider', () => ({
      ...actualUi,
      useUiPathname: () => '/projects/p1/settings',
    }));

    const { ProjectNavItems: NavWithActive } = await import('./project-nav-items');
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(NavWithActive, {
          projectId: 'p1',
        }),
      ),
    );

    expect(html).toContain('data-slot="capability-nav"');
    expect(html).toContain('Capability Nav');
  });
});

