'use client';

/**
 * The manifest's open issues on the Git tab, directly under the "Manifest
 * file" row. The sidebar footer row (`ProjectManifestIssuesAlert`) is the
 * only other place they show, and the settings nav drills over it, so without
 * this a person editing the manifest path never sees that the file has issues.
 *
 * Same data, same filter, same gate and same fix as the sidebar row: the
 * project detail's `manifest_health` through `attentionHealth`, only for
 * `project.write`, and "Fix with My Kortix" opens one session seeded with
 * `manifestFixPrompt`. A calm tone: the warning colour only with errors.
 */

import type { ProjectManifestHealth } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { WarningIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { attentionHealth, useProjectManifestHealth } from '../../../internal/lib/manifest-health';
import { cn } from '../../../internal/lib/utils';
import { Button } from '../../../primitives/button';
import Loading from '../../../primitives/loading';
import {
  ManifestIssueList,
  manifestFixPrompt,
} from '../../../workspace/sidebar/footer/manifest-issue-list';
import { useConfigureThread } from '../../use-configure-thread';

/** Presentational: renders under renderToStaticMarkup. Nothing unless there are issues. */
export function ManifestIssuesRowView({
  health,
  myKortix,
  pending,
  onFix,
}: {
  health: ProjectManifestHealth | undefined;
  myKortix: boolean;
  pending: boolean;
  onFix: () => void;
}) {
  const t = useTranslations('sidebar.manifestIssues');
  const attention = attentionHealth(health);
  if (attention?.state !== 'issues') return null;
  const { errors, warnings } = attention;
  const syntaxError = attention.issues.some((issue) => issue.path === '<yaml>');

  return (
    <div data-slot="manifest-issues" className="space-y-1 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-foreground flex min-w-0 items-center gap-1.5 text-sm">
          <WarningIcon
            aria-hidden
            className={cn('size-4 shrink-0', errors > 0 ? 'text-kortix-orange' : 'text-muted-foreground')}
          />
          {t(warnings === 0 ? 'countErrors' : errors === 0 ? 'countWarnings' : 'count', { errors, warnings })}
        </p>
        <Button size="sm" variant="outline" disabled={pending} onClick={onFix}>
          {pending ? <Loading className="size-3.5 shrink-0" /> : null}
          {myKortix ? t('fix') : t('fixInSession')}
        </Button>
      </div>
      {syntaxError ? null : (
        <p className="text-muted-foreground text-xs">{errors > 0 ? t('errorsOff') : t('warningsOnly')}</p>
      )}
      <ManifestIssueList health={attention} />
    </div>
  );
}

export function ManifestIssuesRow({
  projectId,
  canWrite,
}: {
  projectId: string;
  /** `project.write`, the sidebar row's gate. The Git tab already resolved it (`canManage`). */
  canWrite: boolean;
}) {
  const health = useProjectManifestHealth(projectId);
  // The fix wiring mounts only when there is something to fix.
  if (!canWrite || attentionHealth(health)?.state !== 'issues') return null;
  return <ManifestIssuesRowWithFix projectId={projectId} health={health!} />;
}

function ManifestIssuesRowWithFix({ projectId, health }: { projectId: string; health: ProjectManifestHealth }) {
  const myKortix = useProjectConfig(projectId)?.builtin_agents?.my_kortix === true;
  const configure = useConfigureThread(projectId, { resetOnNavigate: true });
  return (
    <ManifestIssuesRowView
      health={health}
      myKortix={myKortix}
      pending={configure.pending}
      onFix={() =>
        configure.start({
          text: manifestFixPrompt(health),
          agent: myKortix ? MY_KORTIX_AGENT_NAME : null,
          model: null,
          variant: null,
        })
      }
    />
  );
}
