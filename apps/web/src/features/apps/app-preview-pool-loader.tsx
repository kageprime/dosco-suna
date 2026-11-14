'use client';

import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import { CLIPBOARD_IFRAME_ALLOW } from '@kortix/ui/internal/lib/security/iframe-sandbox';
import { framePolicy } from '@kortix/ui/file-viewer';
import type { App } from '@kortix/sdk';
import { useAppAccess, useProjectApps } from '@kortix/sdk/react';
import { useEffect, useLayoutEffect, useState } from 'react';

import { ARTIFACT_FRAME_PREFIX } from '@kortix/ui/artifacts';

import {
  ensureFrame,
  frameKey,
  framesKeepAlive,
  pruneFrames,
  appCan,
  cardPreviewApp,
  gridApps,
} from '@kortix/ui/apps';

/** At most this many Apps load in the background; the rest load when first shown. */
// ponytail: a fixed cap, rank by recent use if a project outgrows it.
const PRELOAD_LIMIT = 12;

/** The project whose frames the pool holds. */
let poolProject: string | null = null;

/**
 * The previews the Apps page opens on: every card's thumbnail, and the first
 * tab of an App that shows no thumbnail of its own (a backend's dashboard).
 */
export function preloadApps(apps: App[], canAdmin: boolean): App[] {
  const opens = (app: App) =>
    appCan(app, 'preview') && !!app.active_deployment_id && app.viewer_can_access !== false;
  const picked: App[] = [];
  for (const app of gridApps(apps, canAdmin)) {
    const shown = cardPreviewApp(apps, app, canAdmin);
    if (shown && opens(shown)) picked.push(shown);
  }
  return picked.slice(0, PRELOAD_LIMIT);
}

/**
 * Drops every pooled frame when the open project changes, artifact frames
 * (`ArtifactFramePreloader`) included. Mounted by the
 * project shell on every route, so a move from one project's Apps page to
 * another project's settings page (where no loader runs) still drops them.
 * Only another project drops them: the shell can remount while it settles,
 * and that must not throw away a loaded App.
 */
export function usePreviewPoolProject(projectId: string) {
  // A layout effect: it runs before the loaders' own (passive) effects, so a
  // prune never deletes frames the new project's loaders just created.
  useLayoutEffect(() => {
    if (poolProject !== null && poolProject !== projectId) pruneFrames(new Set());
    poolProject = projectId;
  }, [projectId]);
}

/**
 * Loads the project's App previews in the background once the page is idle,
 * so the Apps page and the big view show them already loaded. Mounted in the
 * project shell: the frames survive every page switch inside the project.
 */
export function AppPreviewPoolLoader({ projectId }: { projectId: string }) {
  const apps = useProjectApps(projectId);
  const canAdmin = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_ADMIN).allowed === true;
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!framesKeepAlive()) return;
    // Safari has no requestIdleCallback.
    const idleCallback = 'requestIdleCallback' in window;
    const handle = idleCallback
      ? window.requestIdleCallback(() => setIdle(true), { timeout: 2000 })
      : window.setTimeout(() => setIdle(true), 1500);
    return () => (idleCallback ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, []);

  // A new release or a deleted App drops its old frame; leaving the project drops all.
  useEffect(() => {
    if (apps.data) pruneFrames(new Set(apps.data.map(frameKey)), (key) => !key.startsWith(ARTIFACT_FRAME_PREFIX));
  }, [apps.data]);
  if (!idle || !apps.data) return null;
  return (
    <>
      {preloadApps(apps.data, canAdmin).map((app) => (
        <PreloadFrame key={frameKey(app)} projectId={projectId} app={app} />
      ))}
    </>
  );
}

function PreloadFrame({ projectId, app }: { projectId: string; app: App }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const access = useAppAccess(projectId, app.app_id, { policy: false, session: true });
  const url = access.session.data?.url;
  const title = tI18nComplete('text04132f84d7c3', { value0: app.name });
  useEffect(() => {
    if (url) ensureFrame(frameKey(app), url, { title, sandbox: framePolicy('app', url).sandbox, allow: CLIPBOARD_IFRAME_ALLOW });
  }, [app, url, title]);
  return null;
}
