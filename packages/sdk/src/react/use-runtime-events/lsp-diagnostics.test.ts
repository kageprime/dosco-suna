import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

// The debounced fetch reads the active runtime url and goes through the
// authenticated fetch (the no-render mock pattern of
// `hydrate-from-pending.test.ts`): every fetch is recorded, never sent.
const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';
const fetches: string[] = [];
const realActive = await import('../../core/session/server-store/active');
mock.module('../../core/session/server-store/active', () => ({
  ...realActive,
  getActiveRuntimeUrl: () => RUNTIME,
}));
const realAuth = await import('../../core/http/auth');
mock.module('../../core/http/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    fetches.push(new URL(new Request(input, init).url).pathname.replace('/v1/p/sbx_1/8000', ''));
    return Response.json({
      '/src/server.js': [{ line: 1, column: 1, severity: 1, message: 'boom' }],
    });
  },
}));

const { createLspDiagnostics } = await import('./lsp-diagnostics');
const { runtimeKeys } = await import('../use-runtime-sessions');
const { useDiagnosticsStore } = await import('../../browser/stores/diagnostics-store');

function lspWithCache(
  project?: { worktree?: string },
  pathInfo?: { directory?: string; worktree?: string },
) {
  const queryClient = new QueryClient();
  if (project) queryClient.setQueryData(runtimeKeys.currentProject(), project);
  if (pathInfo) queryClient.setQueryData(runtimeKeys.pathInfo(), pathInfo);
  return createLspDiagnostics({ queryClient });
}

beforeEach(() => {
  fetches.length = 0;
  useDiagnosticsStore.getState().clearAll();
});

describe('normalizeLspPath', () => {
  test('strips the project worktree prefix from an absolute sandbox path', () => {
    const lsp = lspWithCache({ worktree: '/workspace/desktop/express-crud-app' });
    expect(lsp.normalizeLspPath('/workspace/desktop/express-crud-app/src/server.js')).toBe(
      'src/server.js',
    );
  });

  test('the longest of the cached prefixes wins', () => {
    // The project worktree and the path info's directory both prefix the file;
    // only the most specific one may be stripped, or the remaining path is
    // still absolute ("desktop/…/src/server.js") and the file tree misses it.
    const lsp = lspWithCache(
      { worktree: '/workspace/desktop/express-crud-app' },
      { directory: '/workspace/desktop/express-crud-app/src' },
    );
    expect(lsp.normalizeLspPath('/workspace/desktop/express-crud-app/src/server.js')).toBe(
      'server.js',
    );
  });

  test('a "/" prefix is skipped, not stripped to a bare relative path', () => {
    const lsp = lspWithCache(undefined, { directory: '/' });
    expect(lsp.normalizeLspPath('/workspace/src/server.js')).toBe('/workspace/src/server.js');
  });

  test('a path under no cached prefix is returned unchanged', () => {
    const lsp = lspWithCache({ worktree: '/workspace/other' });
    expect(lsp.normalizeLspPath('/workspace/src/server.js')).toBe('/workspace/src/server.js');
  });

  test('a relative or empty path is returned as-is', () => {
    const lsp = lspWithCache({ worktree: '/workspace/desktop/express-crud-app' });
    expect(lsp.normalizeLspPath('src/server.js')).toBe('src/server.js');
    expect(lsp.normalizeLspPath('')).toBe('');
  });
});

describe('normalizeDiagnosticPaths', () => {
  test('remaps every file key and keeps the diagnostic arrays', () => {
    const lsp = lspWithCache({ worktree: '/workspace/desktop/express-crud-app' });
    const diags = [{ line: 3, column: 7, severity: 2, message: 'unused' }];
    const out = lsp.normalizeDiagnosticPaths({
      '/workspace/desktop/express-crud-app/src/server.js': diags,
    });
    expect(out).toEqual({ 'src/server.js': diags });
  });
});

describe('fetchLspDiagnosticsDebounced', () => {
  test('coalesces two lsp.updated calls into ONE fetch 250 ms later', async () => {
    const lsp = lspWithCache({ worktree: '/src' });
    jest.useFakeTimers();
    try {
      lsp.fetchLspDiagnosticsDebounced();
      lsp.fetchLspDiagnosticsDebounced();
      expect(fetches).toHaveLength(0);
      jest.advanceTimersByTime(250);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(fetches).toEqual(['/lsp/diagnostics']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a burst landing after the fetch fired fetches again', async () => {
    const lsp = lspWithCache({ worktree: '/src' });
    jest.useFakeTimers();
    try {
      lsp.fetchLspDiagnosticsDebounced();
      jest.advanceTimersByTime(250);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      lsp.fetchLspDiagnosticsDebounced();
      jest.advanceTimersByTime(250);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      expect(fetches).toEqual(['/lsp/diagnostics', '/lsp/diagnostics']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the fetched map is normalized and replaces the store wholesale', async () => {
    const lsp = lspWithCache({ worktree: '/src' });
    jest.useFakeTimers();
    try {
      useDiagnosticsStore
        .getState()
        .setFileDiagnostics('stale.js', [
          { file: 'stale.js', line: 1, column: 1, severity: 1, message: 'stale' },
        ]);
      lsp.fetchLspDiagnosticsDebounced();
      jest.advanceTimersByTime(250);
      for (let i = 0; i < 50; i++) await Promise.resolve();
      // Absolute → relative before the write, and the endpoint returns the
      // complete state, so the stale entry is gone.
      expect(Object.keys(useDiagnosticsStore.getState().byFile)).toEqual(['server.js']);
    } finally {
      jest.useRealTimers();
    }
  });
});
