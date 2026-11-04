'use client';

/**
 * The React half of Mod+, — see `settings-shortcut.ts` for the match itself and
 * for why the keystroke is homed with the panel rather than with the sidebar.
 */

import { useEffect } from 'react';

import { useOptionalSidebar } from '@kortix/ui/sidebar';
import { useIsMobile } from '@kortix/ui';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import { matchesSettingsShortcut } from './settings-shortcut';

/**
 * Bind Mod+, for as long as the caller is mounted. Mounted by `SettingsPanel`
 * itself, so there is one binding per panel and no way to advertise the
 * keystroke on a surface that cannot answer it.
 */
export function useSettingsKeyboardShortcut(projectId?: string) {
  const openSettings = useSettingsPanelStore((s) => s.openSettings);
  const isMobile = useIsMobile();
  const sidebar = useOptionalSidebar();
  const setOpenMobile = sidebar?.setOpenMobile;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!matchesSettingsShortcut(event)) return;
      event.preventDefault();
      if (isMobile) setOpenMobile?.(false);
      openSettings();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openSettings, isMobile, setOpenMobile]);
}
