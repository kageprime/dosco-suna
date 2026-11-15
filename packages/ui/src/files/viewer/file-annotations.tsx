'use client';

/**
 * Diagnostics a surface knows about a file that the LSP store does not: the
 * repository view passes the server's `kortix.yaml` issues here, so the open
 * manifest marks the flagged line and its card carries a warning mark.
 *
 * Outside a provider every file has none, so the viewer, its thumbnails and
 * every other surface render exactly as before.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { LspDiagnostic } from '../../internal/stores/diagnostics-store';

type DiagnosticsFor = (filePath: string) => LspDiagnostic[];

const NONE: LspDiagnostic[] = [];
const FileAnnotationsContext = createContext<DiagnosticsFor>(() => NONE);

export function FileAnnotationsProvider({
  diagnosticsFor,
  children,
}: {
  diagnosticsFor: DiagnosticsFor;
  children: ReactNode;
}) {
  return <FileAnnotationsContext.Provider value={diagnosticsFor}>{children}</FileAnnotationsContext.Provider>;
}

/** The surface's diagnostics for one file. Stable while the provider and path are. */
export function useFileAnnotations(filePath: string | null | undefined): LspDiagnostic[] {
  const diagnosticsFor = useContext(FileAnnotationsContext);
  return useMemo(() => (filePath ? diagnosticsFor(filePath) : NONE), [diagnosticsFor, filePath]);
}
