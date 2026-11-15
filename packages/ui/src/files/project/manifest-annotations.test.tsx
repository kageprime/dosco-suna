/**
 * The repository view's kortix.yaml issues reach the file card and the file
 * viewer through `ManifestAnnotationsProvider`. The project detail is seeded
 * into the query cache the provider reads, so the real chain runs: detail →
 * `manifest_health` → `attentionHealth` → per-file diagnostics.
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectManifestHealth } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileContentRenderer } from '../viewer/file-content-renderer';
import { FileSourceProvider, type FileSource } from '../viewer/file-source';
import { ManifestIssueMark } from './components/manifest-issue-mark';
import { ManifestAnnotationsProvider } from './manifest-annotations';

const PROJECT = 'project_synthetic';
const HEALTH: ProjectManifestHealth = {
  path: 'kortix.yaml',
  state: 'issues',
  errors: 0,
  warnings: 1,
  issues: [
    { path: 'apps.sample.monthly_budget_usd', message: 'is retired and ignored.', severity: 'warning', line: 96, column: 5 },
  ],
};

const source: FileSource = {
  id: 'manifest-annotations',
  useFileContent: () => ({ data: { type: 'text', content: 'kortix_version: 3\n' }, isLoading: false, error: null, refetch: async () => undefined }),
  useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
  download: async () => undefined,
  upload: async () => undefined,
};

function render(node: ReactNode, { onDefaultBranch = true, health = HEALTH } = {}) {
  const client = new QueryClient();
  client.setQueryData(qk.project.detail(PROJECT), { config: { manifest_health: health } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ManifestAnnotationsProvider projectId={PROJECT} onDefaultBranch={onDefaultBranch}>
        <FileSourceProvider value={source}>{node}</FileSourceProvider>
      </ManifestAnnotationsProvider>
    </QueryClientProvider>,
  );
}

describe('kortix.yaml issues in the repository view', () => {
  test('the manifest card carries a mark that says what the file has; other cards none', () => {
    const html = render(<ManifestIssueMark path="kortix.yaml" name="kortix.yaml" />);
    expect(html).toContain('data-slot="manifest-issue-mark"');
    expect(html).toContain('aria-label="kortix.yaml has 1 warning"');
    expect(render(<ManifestIssueMark path="README.md" name="README.md" />)).toBe('');
  });

  test('the viewer counts the warning in its header for the manifest, and nothing for another file', () => {
    const manifest = render(<FileContentRenderer filePath="kortix.yaml" />);
    expect(manifest).toContain('text-kortix-orange inline-flex items-center gap-0.5 text-xs font-medium tabular-nums');
    const other = render(<FileContentRenderer filePath="notes.yaml" />);
    expect(other).not.toContain('text-kortix-orange inline-flex items-center gap-0.5');
  });

  test('another version of the repository shows none: the server validated the default branch', () => {
    expect(render(<ManifestIssueMark path="kortix.yaml" name="kortix.yaml" />, { onDefaultBranch: false })).toBe('');
  });

  test('a healthy manifest shows none', () => {
    expect(
      render(<ManifestIssueMark path="kortix.yaml" name="kortix.yaml" />, {
        health: { path: 'kortix.yaml', state: 'ok', errors: 0, warnings: 0, issues: [] },
      }),
    ).toBe('');
  });
});
