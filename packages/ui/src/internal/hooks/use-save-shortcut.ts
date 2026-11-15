import { useEffect } from 'react';

/**
 * Mod+S (⌘S, Ctrl+S) calls `onSave` while `enabled` is true. With nothing to
 * save the key keeps the browser's own behavior. A key pressed inside an open
 * dialog belongs to that dialog, never to the page's draft. Caps Lock does not
 * change the match.
 */
export function useSaveShortcut(enabled: boolean, onSave: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 's') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      onSave();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onSave]);
}
