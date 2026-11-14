'use client';

import { useComposerPrefillStore } from '@kortix/ui/internal/stores/composer-prefill-store';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef } from 'react';

/**
 * The project id when the address is a project home, else `null`: the home
 * (`/workspaces/<id>`) and the chat it redirects to when chats are on
 * (`/workspaces/<id>/chat`, whose `SpaceView` consumes the same store), with
 * or without a locale prefix. Both are one route for the buffer, so the
 * redirect neither restarts nor drops it. A session route keeps its own
 * draft, and `/workspaces/start` is not a project.
 */
export function homeProjectIdFromPath(pathname: string | null): string | null {
  const match = pathname?.match(/\/workspaces\/([^/?#]+)(?:\/chat)?\/?$/);
  const id = match?.[1];
  return id && id !== 'start' ? decodeURIComponent(id) : null;
}

/** The home composer's editor. While it is absent, typed keys have no target. */
const COMPOSER_EDITOR = '[data-composer-editor]';

/**
 * Keeps what a person types while the project home is still loading.
 *
 * Until the home composer's editor exists, the page has no input: first the
 * loading frame (`ProjectPendingScreen`), then the shell while the lazy editor
 * mounts. Under a slow API that lasts seconds, and every key typed in it
 * reached `<body>` and was lost (product audit F-023: 13 of 15 words lost at
 * 12 s of API latency).
 *
 * Printable keys and Backspace aimed at `<body>` now build a buffer, stored
 * as a `restoreDraft` prefill in `useComposerPrefillStore`. Each key writes
 * the WHOLE buffer, so whichever write the home composer's host consumes last
 * (`ProjectHome`, or `SpaceView` when home opens a chat) carries every key;
 * the composer appends it to the restored draft once the editor exists. An
 * empty buffer is written too, so Backspace can take back a write that was
 * already consumed. The buffer resets once the editor exists.
 *
 * Only keys whose target is `<body>` are taken: a focused button or link
 * (an access-gate screen, the sidebar) keeps its own keys, Space included.
 * A prompt handed over by another surface (desktop Quick Entry, `?q=`) wins:
 * once one appears, the buffer stops until the editor exists, even after the
 * host consumed it from the store.
 *
 * A layout effect, not a passive one: React runs child passive effects before
 * the parent's, so `ProjectHome` (a child) could consume a handed-over
 * prompt before a passive subscription here saw it.
 *
 * The handover latch lives in a ref, so StrictMode's dev re-run of the effect
 * keeps it after `ProjectHome` consumed the prompt.
 *
 * The entry is not dropped when the route leaves the home: home redirects to
 * `/chat` when chats are on, and `SpaceView` consumes it there. A buffer left
 * behind (keys typed on an access-gate screen, then the person leaves every
 * workspace page before a home composer mounts) is dropped on the next mount,
 * so it never shows on a later visit or to another account.
 *
 * The buffer belongs to the person who typed it. When the signed-in user
 * changes without a page load (another tab signs out, or signs in as someone
 * else), the entry is dropped before the next viewer's composer can read it.
 * Only a different signed-in id counts: `null` is the session still resolving
 * (a hard load, or the auth bootstrap flickering), the window this buffer
 * exists for. A sign-out from this tab reloads the page (`performSignOut`),
 * which empties the in-memory store anyway.
 *
 * Mounted by `ProjectAccessBoundary`, which stays mounted from the first
 * paint to the composer. Keys typed before React hydrates are not seen.
 * Enter is ignored: nothing is sent from a screen the person cannot see.
 * Shortcuts (Cmd, Ctrl, Alt) and IME composition pass through untouched.
 */
export function useHomeTypingBuffer(viewerUserId: string | null): void {
  const projectId = homeProjectIdFromPath(usePathname());
  const latch = useRef<{ projectId: string | null; handedOver: boolean; text: string }>({ projectId: null, handedOver: false, text: '' });
  const lastViewer = useRef<string | null>(null);

  // Mount: an entry this hook did not write in this mount is stale. It was
  // left by an earlier visit, maybe by another account that signed in while
  // no workspace page (and so no buffer) was open. This hook stays mounted
  // from the first paint through the redirect to the chat, so a live buffer
  // is never older than the mount.
  useLayoutEffect(() => {
    const prefills = useComposerPrefillStore.getState();
    for (const [id, entry] of Object.entries(prefills.prefillByProject)) {
      if (entry.restoreDraft) prefills.consume(id);
    }
  }, []);

  useLayoutEffect(() => {
    const previousViewer = lastViewer.current;
    if (viewerUserId) lastViewer.current = viewerUserId;
    if (previousViewer && viewerUserId && previousViewer !== viewerUserId) {
      // Everything in the store was written before this account change, so it
      // belongs to the previous viewer: keys this buffer took and prompts
      // other surfaces handed over (some send themselves on arrival).
      // `resetClientState` empties the store too; this also covers the
      // buffer's own text, which lives in this hook.
      latch.current.text = '';
      const prefills = useComposerPrefillStore.getState();
      for (const id of Object.keys(prefills.prefillByProject)) prefills.consume(id);
    }
    if (!projectId || typeof window === 'undefined') {
      latch.current = { projectId: null, handedOver: false, text: '' };
      return;
    }
    if (latch.current.projectId !== projectId) latch.current = { projectId, handedOver: false, text: '' };
    const state = latch.current;
    const watch = (entry: { restoreDraft?: boolean } | undefined) => {
      if (entry && !entry.restoreDraft) state.handedOver = true;
    };
    watch(useComposerPrefillStore.getState().prefillByProject[projectId]);
    const unsubscribe = useComposerPrefillStore.subscribe((store) => watch(store.prefillByProject[projectId]));

    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector(COMPOSER_EDITOR)) {
        state.text = '';
        state.handedOver = false;
        return;
      }
      if (state.handedOver || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (event.key === 'Backspace') {
        if (!state.text) return;
        state.text = state.text.slice(0, -1);
      } else if (event.key.length === 1) {
        state.text += event.key;
      } else {
        return;
      }
      // Space would scroll the page; the key belongs to the composer.
      event.preventDefault();
      useComposerPrefillStore.getState().setPrefill(projectId, state.text, { restoreDraft: true });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unsubscribe();
    };
  }, [projectId, viewerUserId]);
}
