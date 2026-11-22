'use client';

/**
 * ProjectManifestIssuesAlert — the sidebar footer row that tells a person who
 * may write the project that `kortix.yaml` has issues, and offers one fix.
 *
 * The server validates the manifest (`manifest_health` on the project detail).
 * A running project never stops on it: it applies the valid rest, and an agent
 * or trigger with an error is off. So the row is a calm `warning` with errors
 * and `neutral` with warnings only, never a failure colour.
 *
 * Expanded, it lists each issue (`file:line:col`, severity, key, message) and
 * offers "Fix with My Kortix": a new session, seeded with `manifestFixPrompt`,
 * that fixes the file, runs `kortix validate` and opens a change request it
 * does not merge. In a project that does not run My Kortix (no `builtin_agents.my_kortix: true`)
 * the session runs the project's default agent.
 *
 * Renders only for `state === 'issues'` and `project.write`. `ok`, `missing`
 * (built-in agents only) and the unread states show nothing here.
 */

import { type ProjectManifestHealth } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { FileCodeIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../../i18n';
import { useConfigureThread } from '../../../customize/use-configure-thread';
import { attentionHealth, useProjectManifestHealth } from '../../../internal/lib/manifest-health';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectPageCans } from '../../../internal/lib/use-project-can';
import { Button } from '../../../primitives/button';
import Loading from '../../../primitives/loading';
import { ManifestIssueList, manifestFixPrompt } from '../../../customize/sections/view/manifest-issue-list';
import { SidebarAlert, SidebarAlertActions, SidebarAlertBody, SidebarAlertText } from './sidebar-alert';

// The fix prompt and the issue list are shared with the Git tab
// (`customize/sections/view/manifest-issues-row.tsx`).
export { attentionHealth, ManifestIssueList, manifestFixPrompt };

/** Presentational shell: no data fetching, so every state renders under
 *  renderToStaticMarkup. The reads and the permission gate live in the wrapper. */
export function ProjectManifestIssuesAlertView({
  health,
  myKortix,
  pending,
  onFix,
  defaultOpen = false,
}: {
  health: ProjectManifestHealth | undefined;
  /** False when the project turned My Kortix off: the action names no agent. */
  myKortix: boolean;
  pending: boolean;
  onFix: () => void;
  /** Seed the disclosure open, for tests; the sidebar starts collapsed. */
  defaultOpen?: boolean;
}) {
  const t = useTranslations('sidebar.manifestIssues');
  const [isOpen, setIsOpen] = useState(defaultOpen);
  health = attentionHealth(health);
  if (health?.state !== 'issues') return null;
  const file = health.path ?? 'kortix.yaml';
  const syntaxError = health.issues.some((issue) => issue.path === '<yaml>');

  return (
    <SidebarAlert
      tone={health.errors > 0 ? 'warning' : 'neutral'}
      icon={<FileCodeIcon className="size-4 shrink-0" />}
      label={t(health.warnings === 0 ? 'titleErrors' : health.errors === 0 ? 'titleWarnings' : 'title', { file, errors: health.errors, warnings: health.warnings })}
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <SidebarAlertBody>
        {/* A syntax error's own message says what runs until it is fixed (the last version that parses, or only My Kortix). */}
        {syntaxError ? null : <SidebarAlertText>{health.errors > 0 ? t('errorsOff') : t('warningsOnly')}</SidebarAlertText>}
        <ManifestIssueList health={health} />
      </SidebarAlertBody>
      <SidebarAlertActions>
        <Button size="sm" className="w-full" disabled={pending} onClick={onFix}>
          {pending ? <Loading className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{myKortix ? t('fix') : t('fixInSession')}</span>
        </Button>
      </SidebarAlertActions>
    </SidebarAlert>
  );
}

export function ProjectManifestIssuesAlert({ projectId }: { projectId: string }) {
  const health = useProjectManifestHealth(projectId);
  const myKortix = useProjectConfig(projectId)?.builtin_agents?.my_kortix === true;
  const canWrite = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;
  const configure = useConfigureThread(projectId, { resetOnNavigate: true });
  if (!canWrite || !health) return null;

  return (
    <ProjectManifestIssuesAlertView
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
