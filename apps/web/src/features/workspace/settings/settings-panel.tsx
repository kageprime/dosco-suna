'use client';

/**
 * The Settings overlay's mount point: always rendered by project-shell.tsx and
 * the standalone /settings route, and deliberately tiny.
 */

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import { withStaleChunkRecovery } from '@kortix/ui/internal/lib/chunk-reload';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import { useSettingsKeyboardShortcut } from './use-settings-shortcut';

const SettingsPanelBody = dynamic(
  withStaleChunkRecovery(() => import('./settings-panel-body').then((m) => m.SettingsPanelBody)),
  { ssr: false },
);

/** Start loading the panel body; for triggers that can prefetch on intent. */
function preloadSettingsPanel(): void {
  import('./settings-panel-body').catch(() => {
    /* A stale-deploy chunk fails here before the user asks for the panel;
       the recovery reload happens on open. */
  });
}

const IDLE_PRELOAD_TIMEOUT_MS = 5_000;

function preloadWhenIdle(): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(preloadSettingsPanel, { timeout: IDLE_PRELOAD_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(preloadSettingsPanel, IDLE_PRELOAD_TIMEOUT_MS);
  return () => window.clearTimeout(handle);
}

export function SettingsPanel({ projectId }: { projectId?: string }) {
  useSettingsKeyboardShortcut();

  useEffect(preloadWhenIdle, []);

  const open = useSettingsPanelStore((s) => s.open);
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return <SettingsPanelBody projectId={projectId} />;
}
