'use client';

/**
 * The repository view's `kortix.yaml` issues, as file annotations: the open
 * manifest gets a gutter marker and a hover message on each flagged line, and
 * its card a warning mark. The same `attentionHealth` filter as the sidebar
 * row, so an issue shows or hides the same everywhere.
 *
 * The server validates the default branch's manifest, so another version of
 * the repository (a change request, a checkpoint) shows none.
 */

import { useCallback, type ReactNode } from 'react';

import { manifestLspDiagnostics, useProjectManifestHealth } from '../../internal/lib/manifest-health';
import { FileAnnotationsProvider } from '../viewer/file-annotations';

export function ManifestAnnotationsProvider({
  projectId,
  onDefaultBranch,
  children,
}: {
  projectId: string;
  /** False while the view shows another ref than the default branch. */
  onDefaultBranch: boolean;
  children: ReactNode;
}) {
  const health = useProjectManifestHealth(projectId);
  const diagnosticsFor = useCallback(
    (filePath: string) => (onDefaultBranch ? manifestLspDiagnostics(health, filePath) : []),
    [health, onDefaultBranch],
  );
  return <FileAnnotationsProvider diagnosticsFor={diagnosticsFor}>{children}</FileAnnotationsProvider>;
}
