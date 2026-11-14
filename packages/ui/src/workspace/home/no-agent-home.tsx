'use client';

import { ArrowSquareOutIcon, CheckIcon, CopyIcon, FileCodeIcon, LockSimpleIcon, RobotIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { useTranslations } from '../../i18n';
import { copyToClipboard } from '../../internal/lib/utils/clipboard';
import { Button } from '../../primitives/button';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { errorToast } from '../../primitives/toast';

import { EXISTING_REPO_DOCS_URL, existingRepoSetupPrompt, repositoryLabel } from './existing-repo-setup-prompt';

/**
 * Why no agent runs here. `setup`: the repository has no `kortix.yaml` and the
 * viewer may change the project. `noAccess`: the viewer may run none of the
 * project's agents. `empty`: `kortix.yaml` exists and declares no agent.
 */
export type NoAgentReason = 'setup' | 'noAccess' | 'empty';

/**
 * Project home when no agent can run for the viewer: the composer would refuse
 * every send ("No agents available to you"), so the chat area is one calm
 * blocked state instead of a composer that looks live and is not.
 *
 * `setup` carries the fix. Kortix never writes to a linked repository: the
 * person copies a prompt (`existing-repo-setup-prompt.ts`) into their own
 * coding agent, which writes `kortix.yaml` and pushes it. The prompt is not
 * shown; the button copies it and confirms in place. The home re-reads the
 * project while this is shown and becomes the chat once an agent exists.
 *
 * `noAccess` and `empty` carry no button: the viewer cannot act here, and
 * "New agent" already sits in the sidebar.
 */
export function NoAgentHome({
  reason,
  repoUrl,
  branch,
  dashboardUrl,
}: {
  reason: NoAgentReason;
  repoUrl: string | null | undefined;
  branch: string | null | undefined;
  /** The project's web page (`dashboard_url`): the copied prompt names this deployment's guide. */
  dashboardUrl?: string | null;
}) {
  const t = useTranslations('noAgentHome');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyPrompt = async () => {
    const prompt = existingRepoSetupPrompt({ repository: repositoryLabel(repoUrl), branch, dashboardUrl });
    if (await copyToClipboard(prompt)) setCopied(true);
    else errorToast(t('copyFailed'));
  };

  const code = (chunks: React.ReactNode) => <code className="text-foreground font-mono">{chunks}</code>;

  return (
    <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6 transition-opacity duration-(--duration-slow) ease-out starting:opacity-0">
      {reason === 'setup' ? (
        <EmptyState
          media={<EmptyArt icon={FileCodeIcon} />}
          title={t('setup.title')}
          description={t.rich('setup.body', { branch: branch || t('defaultBranch'), code })}
          action={
            <Button variant="outline" size="sm" className="gap-1.5" onClick={copyPrompt}>
              {copied ? <CheckIcon className="size-3.5 shrink-0" aria-hidden /> : <CopyIcon className="size-3.5 shrink-0" aria-hidden />}
              {copied ? t('copied') : t('copy')}
            </Button>
          }
          secondaryAction={
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <a href={EXISTING_REPO_DOCS_URL} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon className="size-3.5 shrink-0" aria-hidden />
                {t('docs')}
              </a>
            </Button>
          }
        />
      ) : (
        <EmptyState
          media={<EmptyArt icon={reason === 'noAccess' ? LockSimpleIcon : RobotIcon} />}
          title={t(`${reason}.title`)}
          description={t(`${reason}.body`)}
        />
      )}
    </div>
  );
}
