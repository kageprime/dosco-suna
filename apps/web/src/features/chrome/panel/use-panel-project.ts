'use client';

import type { KortixProject } from '@kortix/sdk';
import { readLastProjectId } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import { useMemo, useState } from 'react';

const projectKey = (userId: string) => `kortix.panel.project.${userId}`;

function rememberedProject(userId: string): string | null {
  try {
    return window.localStorage.getItem(projectKey(userId));
  } catch {
    return null;
  }
}

function rememberProject(userId: string, projectId: string) {
  try {
    window.localStorage.setItem(projectKey(userId), projectId);
  } catch {
    // A blocked store only loses the remembered project.
  }
}

/** The project the panel talks to: the picked one, else remembered, else the last one, else the first. */
export function usePanelProject({ userId, projects }: { userId: string | null; projects: KortixProject[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = useMemo(() => {
    const known = (id: string | null) => (id && projects.some((p) => p.project_id === id) ? id : null);
    const stored = userId ? known(rememberedProject(userId)) ?? known(readLastProjectId(userId)) : null;
    return known(picked) ?? stored ?? projects[0]?.project_id ?? null;
  }, [picked, projects, userId]);
  const pickProject = (id: string) => {
    setPicked(id);
    if (userId) rememberProject(userId, id);
  };
  return { projectId, pickProject };
}
