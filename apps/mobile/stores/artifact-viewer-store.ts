/**
 * Which artifact the viewer sheet shows (`ArtifactViewerSheet`, mounted once
 * in the project screen). The Artifacts page rows and a session's `show` rows
 * and message links all open HERE, so the page or the thread stays mounted
 * underneath and the sheet's X returns to the same place.
 *
 * `projectId` is the project whose viewer is mounted: a link opens here only
 * when it names an artifact of that project (`openArtifactLink`).
 *
 * Holds ids and a title only, never the signed `view_url`: the sheet reads the
 * artifact itself, so a reopened artifact always gets a fresh URL.
 */

import { create } from 'zustand';

export interface ArtifactViewerTarget {
  projectId: string;
  artifactId: string;
  /** Shown in the title row until the artifact loads. */
  title?: string;
}

interface ArtifactViewerState {
  /** The project whose viewer is mounted, or null outside a project. */
  projectId: string | null;
  target: ArtifactViewerTarget | null;
  setProjectId: (projectId: string | null) => void;
  open: (target: ArtifactViewerTarget) => void;
  close: () => void;
}

export const useArtifactViewerStore = create<ArtifactViewerState>()((set) => ({
  projectId: null,
  target: null,
  setProjectId: (projectId) => set({ projectId }),
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
