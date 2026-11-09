import type { QueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '../../core/http/auth';
import { useDiagnosticsStore, type RawDiagnostic } from '../../browser/stores/diagnostics-store';
import { getActiveRuntimeUrl } from '../../browser/stores/server-store';
import { type Project, type PathInfo, runtimeKeys } from '../use-runtime-sessions';
import type { NormalizeDiagnosticPaths } from './types';

/**
 * The LSP plumbing behind `useEventStreamRefs`' diagnostics refs, extracted
 * framework-free so it is unit-testable without rendering a hook. The hook
 * wraps the three returned functions back into `useRef`s.
 */
export function createLspDiagnostics({ queryClient }: { queryClient: QueryClient }) {
  /**
   * Resolve an absolute sandbox path to a project-relative path by stripping
   * known worktree/directory prefixes from the React Query cache.
   *
   * For example: `/workspace/desktop/express-crud-app/src/server.js` → `src/server.js`
   *
   * This is critical for LSP diagnostics: the backend sends absolute paths,
   * but the frontend file tree / file viewer uses project-relative paths.
   */
  const normalizeLspPath = (absPath: string): string => {
    if (!absPath || !absPath.startsWith('/')) return absPath;

    // Collect prefixes from cached project/path data
    const prefixes: string[] = [];
    try {
      const project = queryClient.getQueryData<Project>(runtimeKeys.currentProject());
      if (project?.worktree) prefixes.push(project.worktree);
      const pathInfo = queryClient.getQueryData<PathInfo>(runtimeKeys.pathInfo());
      if (pathInfo?.directory) prefixes.push(pathInfo.directory);
      if (pathInfo?.worktree) prefixes.push(pathInfo.worktree);
    } catch {
      // non-critical
    }

    // Deduplicate and sort longest first (most specific prefix wins)
    const unique = [...new Set(prefixes.filter(Boolean))].sort((a, b) => b.length - a.length);

    for (const wt of unique) {
      if (!wt || wt === '/') continue;
      const prefix = wt.endsWith('/') ? wt : wt + '/';
      if (absPath.startsWith(prefix)) {
        return absPath.slice(prefix.length);
      }
    }

    return absPath;
  };

  /** Normalize all keys in a diagnostic map from absolute to relative paths */
  const normalizeDiagnosticPaths: NormalizeDiagnosticPaths = function normalizeDiagnosticPaths<T>(
    diagsByFile: Record<string, T[]>,
  ): Record<string, T[]> {
    const normalized: Record<string, T[]> = {};
    for (const [file, diags] of Object.entries(diagsByFile)) {
      const relPath = normalizeLspPath(file);
      normalized[relPath] = diags;
    }
    return normalized;
  };

  /**
   * Debounced fetch of all LSP diagnostics from the backend.
   *
   * The `lsp.client.diagnostics` SSE event only carries { serverID, path }
   * (no actual diagnostic data). Multiple events fire in rapid succession
   * as the language server reports diagnostics for different files, so we
   * debounce and fetch the full diagnostics map from GET /lsp/diagnostics.
   */
  const fetchLspDiagnosticsDebounced = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        try {
          const baseUrl = getActiveRuntimeUrl();
          const resp = await authenticatedFetch(`${baseUrl}/lsp/diagnostics`);
          if (!resp.ok) return;
          const data = (await resp.json()) as Record<string, RawDiagnostic[]>;
          if (data && typeof data === 'object') {
            const normalized = normalizeDiagnosticPaths(data);
            // The endpoint returns the *complete* diagnostics state,
            // so clear stale entries before applying the fresh data.
            const store = useDiagnosticsStore.getState();
            store.clearAll();
            store.setFromLspEvent(normalized);
          }
        } catch {
          // Silently ignore — diagnostics are non-critical and the
          // endpoint may not be available on every runtime.
        }
      }, 250);
    };
  })();

  return { normalizeLspPath, normalizeDiagnosticPaths, fetchLspDiagnosticsDebounced };
}
