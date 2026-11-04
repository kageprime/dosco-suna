'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import { parseSettingsTab } from '@kortix/ui/customize/settings/settings-tabs';

/**
 * /projects/[id]/settings — Unified Settings entry point.
 * Opens the centralized Antigravity-style settings modal over the project
 * workspace without tearing down the active session.
 */
export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params?.id;
  const tabParam = searchParams.get('tab') || searchParams.get('section');

  useEffect(() => {
    if (!projectId) return;
    const resolvedTab = parseSettingsTab(tabParam) ?? undefined;
    useSettingsPanelStore.getState().openSettings(resolvedTab);
    router.replace(`/projects/${projectId}`);
  }, [projectId, tabParam, router]);

  return null;
}
