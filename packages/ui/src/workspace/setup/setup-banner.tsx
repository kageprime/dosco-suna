'use client';

/**
 * The way back to `/workspaces/<id>/setup`. The workspace home shows it,
 * floating at the bottom of the page, while the setup page has an open step
 * the viewer can finish: a connector to sign in, a required secret, Slack. It
 * counts the same steps as the page. It has no dismiss of its own: "Later" in
 * the setup modal snoozes it for a day (`setup-banner-snooze.ts`), and it goes
 * for good when every step it counts is done.
 */

import { useProjectAccountId } from '@kortix/sdk/react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Button } from '../../primitives/button';
import { UiLink as Link } from '../../providers/ui-provider';
import { openStepsFor } from './setup-steps';
import { useSetupBannerSnoozed } from './setup-banner-snooze';
import { useSetupSteps } from './use-setup-steps';
import { StepLogoStack, useStepCopy } from './workspace-setup-modal';

export function SetupBanner({ projectId, className }: { projectId: string; className?: string }) {
  const t = useTranslations('workspaceSetup');
  const copy = useStepCopy();
  const accountId = useProjectAccountId(projectId);
  const canConnect =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed === true;
  const canSetSecrets = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE).allowed === true;
  const { steps } = useSetupSteps(projectId, { enabled: canConnect || canSetSecrets });
  const open = openStepsFor(steps, { connect: canConnect, setSecrets: canSetSecrets });
  const snoozed = useSetupBannerSnoozed(projectId);
  if (open.length === 0 || snoozed) return null;

  // One open step names itself ("Connect GitHub to finish setup"); more give the count.
  const only = open.length === 1 ? open[0] : null;
  const title = only ? t('bannerNamed', { action: copy.action(only) }) : t('bannerTitle', { left: open.length });

  return (
    <div
      role="status"
      data-testid="setup-banner"
      className={cn(
        // Floats over the home page: the light preset of the soft layered shadow
        // (shadow.floriankiem.com `ring-sm`, the toasts' shadow), hairline included.
        'bg-popover smooth-shadow-ring-sm flex items-center gap-3 rounded-xl py-2 pr-2 pl-3',
        'animate-in fade-in-0 zoom-in-95 duration-normal ease-out motion-reduce:animate-none',
        className,
      )}
    >
      <StepLogoStack steps={open} ringClassName="ring-popover" />
      <p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium" title={open.map((step) => step.name).join(', ')}>
        {title}
      </p>
      <Button asChild size="sm">
        {/* Verb first, and true to where the person is: nothing done yet starts, some done continues. */}
        <Link href={`/workspaces/${projectId}/setup`}>{steps.some((step) => step.done) ? t('bannerContinue') : t('bannerStart')}</Link>
      </Button>
    </div>
  );
}
