'use client';

import { useSyncExternalStore } from 'react';

const key = (projectId: string) => `kortix.setup.skippedConnectors.${projectId}`;
const EVENT = 'kortix:setup-skipped-connectors';

function snapshot(projectId: string): string {
  try {
    return window.localStorage.getItem(key(projectId)) ?? '[]';
  } catch {
    return '[]';
  }
}

function parse(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Browser-local setup preference only. Task-requested sign-ins never read it. */
export function useSkippedConnectors(projectId: string) {
  const raw = useSyncExternalStore(subscribe, () => snapshot(projectId), () => '[]');
  return {
    skipped: parse(raw),
    skip(slug: string) {
      try {
        window.localStorage.setItem(
          key(projectId),
          JSON.stringify([...new Set([...parse(snapshot(projectId)), slug])]),
        );
      } catch {
        // Storage denied: keep the item visible rather than claim it was saved.
      }
      window.dispatchEvent(new Event(EVENT));
    },
    restore() {
      try {
        window.localStorage.removeItem(key(projectId));
      } catch {
        // Storage denied: retain the saved preference.
      }
      window.dispatchEvent(new Event(EVENT));
    },
  };
}
