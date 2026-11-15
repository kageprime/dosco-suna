'use client';

/**
 * The project's `manifest_health`, read from the `qk.project.detail(id)` query
 * the rest of Customize already shares: no second request. `undefined` while
 * the read is in flight, and from an API that does not serve the field yet.
 * The server reads and validates `kortix.yaml`; a client never parses it to
 * decide what state it is in.
 *
 * Every surface that shows the issues (the sidebar row, the Git tab, the
 * Repository file card, the file viewer) filters them through
 * `attentionHealth`, so one issue is hidden or shown the same everywhere.
 */

import { getProjectDetail, type ManifestIssue, type ProjectManifestHealth } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import type { LspDiagnostic } from '../stores/diagnostics-store';

export function useProjectManifestHealth(projectId: string): ProjectManifestHealth | undefined {
  return useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    select: (detail) => detail.config?.manifest_health,
    enabled: !!projectId,
    ...contract('config'),
  }).data;
}

/**
 * The issues a person has to act on: every error, and each warning without a
 * `fix`. A warning with a `fix` (a deprecated key, an older format) heals on
 * the next Kortix write or `kortix validate --fix`, so the sidebar does not
 * ask for it; `kortix validate` and the API still list it.
 */
export function attentionHealth(health: ProjectManifestHealth | undefined): ProjectManifestHealth | undefined {
  if (health?.state !== 'issues') return health;
  const issues = health.issues.filter((issue) => issue.severity === 'error' || !issue.fix);
  // The server's counts can exceed the listed issues: keep them, less the hidden warnings.
  const warnings = Math.max(0, health.warnings - (health.issues.length - issues.length));
  return { ...health, state: health.errors + warnings > 0 ? 'issues' : 'ok', issues, warnings };
}

/**
 * A repository path compared without a leading `./` or `/`, and without the
 * `/workspace` root the Repository view's file paths carry.
 */
function repoPath(path: string): string {
  return path
    .trim()
    .replace(/^\/workspace(?=\/|$)/, '')
    .replace(/^(\.\/|\/)+/, '');
}

/**
 * The attention issues that live in one repository file: the manifest's own
 * (no `file`), or an `imports:` file's. Empty for any other file, and while
 * the manifest has no issues.
 */
export function manifestIssuesForFile(
  health: ProjectManifestHealth | undefined,
  filePath: string,
): ManifestIssue[] {
  const attention = attentionHealth(health);
  if (attention?.state !== 'issues' || !filePath) return [];
  const root = attention.path ?? 'kortix.yaml';
  const target = repoPath(filePath);
  return attention.issues.filter((issue) => repoPath(issue.file ?? root) === target);
}

/**
 * The same issues as editor diagnostics. The server's line and column are
 * 1-indexed; `LspDiagnostic` is 0-indexed. An issue with no line (a file-wide
 * one) marks line 1.
 */
export function manifestLspDiagnostics(
  health: ProjectManifestHealth | undefined,
  filePath: string,
): LspDiagnostic[] {
  return manifestIssuesForFile(health, filePath).map((issue) => ({
    file: filePath,
    line: Math.max(0, (issue.line ?? 1) - 1),
    column: Math.max(0, (issue.column ?? 1) - 1),
    severity: issue.severity === 'error' ? 1 : 2,
    message: issue.path && issue.path !== '<yaml>' ? `${issue.path} ${issue.message}` : issue.message,
    source: 'kortix',
  }));
}
