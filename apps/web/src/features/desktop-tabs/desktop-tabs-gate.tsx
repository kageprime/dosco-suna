'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { isDesktop } from '@kortix/ui/internal/lib/desktop';
import { Component, type ReactNode } from 'react';

/**
 * Whether this project's window draws the tab strip: the desktop shell, with
 * the project's `desktop_tabs` flag on. Fail-closed: while the project row
 * loads, or when it errors, the title bar is the one it was before tabs.
 */
export function useDesktopTabsEnabled(projectId: string): boolean {
  const flag = useFeatureFlag(projectId, 'desktop_tabs');
  return isDesktop() && flag.enabled;
}

/**
 * `<html data-kx-desktop-tabs-mounted>`: the strip is mounted, so it owns the
 * tab shortcuts and links go to tabs. Code that is no React child of the strip
 * reads it at the moment it acts (`desktopTabsMounted()`): the web session-tab
 * shortcuts, the sidebar's artifact list, the Apps page.
 */
export const MOUNTED_ATTRIBUTE = 'data-kx-desktop-tabs-mounted';

/**
 * On the sidebar's Customize link (packages/ui, project-nav-items.tsx): the
 * way into Workspace settings that names no section of its own. The strip
 * sends it to the settings tab you were last in.
 */
export const SETTINGS_ENTRY_ATTRIBUTE = 'data-kx-settings-entry';

export function desktopTabsMounted(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute(MOUNTED_ATTRIBUTE);
}

/**
 * A render error in the strip must never take the project shell down. It
 * unmounts the strip: the window falls back to the title bar it had before
 * tabs, and the page keeps working.
 */
export class DesktopTabsBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[desktop-tabs] the tab strip failed and was turned off for this window', error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
