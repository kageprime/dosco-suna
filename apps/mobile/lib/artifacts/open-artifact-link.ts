/**
 * Open a link in the artifact viewer when it names an artifact of the project
 * on screen (`artifactInProject`). True when the viewer took it; false means
 * the caller keeps its own path (the in-app browser): a public share link, a
 * link into another project, or a website.
 */

import { artifactInProject } from '@/lib/artifacts/artifacts';
import { useArtifactViewerStore } from '@/stores/artifact-viewer-store';

export function openArtifactLink(url: string, title?: string): boolean {
  const { projectId, open } = useArtifactViewerStore.getState();
  const artifactId = artifactInProject(url, projectId);
  if (!projectId || !artifactId) return false;
  open({ projectId, artifactId, ...(title ? { title } : {}) });
  return true;
}
