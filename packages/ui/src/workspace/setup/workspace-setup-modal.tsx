'use client';

import { CheckCircleIcon, KeyIcon } from '@phosphor-icons/react';
import { getSlackMode, type AdminConnector } from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { connectorHref } from '../../customize/connectors/connector-routes';
import { SetCredentialModal } from '../../customize/sections/connectors-view';
import { ProjectSecretDialog } from '../../customize/sections/view/secrets-view';
import { useTranslations } from '../../i18n';
import { ConnectorLogo, type ConnectorLogoSize } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource, resolveConnectorLogo } from '../../internal/connector-logo/connector-logo-source';
import { useAddAccount } from '../../internal/hooks/connectors/use-add-account';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { cn } from '../../lib/utils';
import { AvatarGroup, AvatarGroupCount } from '../../primitives/avatar';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { EmptyArt } from '../../primitives/empty-art';
import { ErrorState } from '../../primitives/error-state';
import { Modal, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Progress } from '../../primitives/progress';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link, useUiSearchParams } from '../../providers/ui-provider';
import type { SetupStep } from './setup-steps';
import { snoozeSetupBanner } from './setup-banner-snooze';
import { useSetupSteps } from './use-setup-steps';

/** While a step is open, read it again this often: the person may finish it in another tab. */
const OPEN_STEP_POLL_MS = 5_000;

/**
 * `/workspaces/<id>/setup`: every step of a workspace's setup that only a
 * person can do, in one modal over the workspace. The route keeps its URL:
 * the web app intercepts it (`@modal/(.)setup`) over the page it was opened
 * from, and a direct load draws it over the workspace home. `kortix onboard`
 * opens that URL instead of printing a link per step, and `kortix onboard
 * --wait` continues when every row is done. A missing model never reaches
 * this modal: the workspace shell shows "Connect a model" first (`ProjectShell`).
 */
export function WorkspaceSetupModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useTranslations('workspaceSetup');
  const params = useUiSearchParams();
  const accountId = useProjectAccountId(projectId);
  const canConnect =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed === true;
  const canSetSecrets = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE).allowed === true;

  const { steps, usesSlack, loading, failed, refresh } = useSetupSteps(projectId, {
    slackRequested: params.get('slack') === '1',
    pollMs: OPEN_STEP_POLL_MS,
  });
  // The same cache entry as the Channels page (`useSlackMode`).
  const slackModeQuery = useQuery({
    queryKey: ['channels', 'slack-mode', projectId],
    queryFn: () => getSlackMode(projectId),
    enabled: usesSlack,
    staleTime: 60_000,
  });
  const open = steps.filter((step) => !step.done);
  const finished = steps.filter((step) => step.done);
  const ready = !loading && !failed && steps.length > 0;
  const complete = ready && open.length === 0;
  const view: StepView = {
    projectId,
    canConnect,
    canSetSecrets,
    slackInstallUrl: slackModeQuery.data?.oauth_available ? slackModeQuery.data.install_url : null,
    refresh,
  };

  // "Later" is the banner's one dismiss: it snoozes it for a day. "Done",
  // Escape and a click outside only close.
  const finishedOrEmpty = complete || (!loading && steps.length === 0);
  const later = () => {
    if (!finishedOrEmpty) snoozeSetupBanner(projectId);
    onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      {/* Landscape: the "why" and the progress in a rail on the left, the work
          on the right. The rail is a lifted region (`bg-sidebar`) beside the
          white work surface, one hairline between them. */}
      <ModalContent
        variant="base"
        className="space-y-0 overflow-hidden lg:grid lg:h-[min(34rem,85vh)] lg:max-w-4xl lg:grid-cols-[17rem_1fr]"
        data-testid="workspace-setup"
      >
        <aside className="bg-sidebar flex flex-col gap-6 border-b px-6 pt-6 pb-5 lg:border-r lg:border-b-0">
          <ModalHeader className="space-y-1.5 p-0 pr-10 lg:pr-0">
            <ModalTitle className="text-xl font-medium text-balance">
              {complete ? t('completeTitle') : t('title')}
            </ModalTitle>
            <ModalDescription className="text-sm text-pretty">{complete ? t('completeDescription') : t('subtitle')}</ModalDescription>
          </ModalHeader>

          {ready ? (
            <div className="space-y-2">
              <p className="text-foreground text-sm font-medium tabular-nums">
                {t('progress', { done: finished.length, total: steps.length })}
              </p>
              <Progress
                value={(finished.length / steps.length) * 100}
                getValueLabel={() => t('progress', { done: finished.length, total: steps.length })}
                className="bg-muted h-1"
                indicatorClassName="bg-kortix-green"
              />
            </div>
          ) : null}

          <div className="mt-auto hidden items-center justify-between gap-3 lg:flex">
            <p className="text-muted-foreground min-w-0 text-sm text-pretty">{ready && !complete ? t('liveNote') : null}</p>
            <Button size="sm" onClick={later}>
              {finishedOrEmpty ? t('done') : t('later')}
            </Button>
          </div>
        </aside>

        <div className="min-h-0 overflow-y-auto px-6 pt-6 pb-6 lg:pt-14">
          {loading ? (
            <ul className="grid gap-2 sm:grid-cols-2" aria-busy="true">
              {[0, 1, 2, 3].map((index) => (
                <li key={index}>
                  <Skeleton className="h-14 rounded-lg" />
                </li>
              ))}
            </ul>
          ) : failed ? (
            <ErrorState
              size="sm"
              title={t('loadFailed')}
              action={
                <Button variant="outline" size="sm" onClick={refresh}>
                  {t('tryAgain')}
                </Button>
              }
            />
          ) : steps.length === 0 ? (
            <EmptyState media={<EmptyArt icon={CheckCircleIcon} />} title={t('emptyTitle')} description={t('emptyDescription')} />
          ) : (
            <div className="space-y-6">
              {open.length > 0 ? (
                <StepSection title={t('sectionOpen')} count={open.length}>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {open.map((step) => (
                      <OpenStepTile key={step.id} view={view} step={step} />
                    ))}
                  </ul>
                </StepSection>
              ) : null}
              {finished.length > 0 ? (
                // What is already done is one quiet line, not a second list:
                // the stack shows which, the count says how many.
                <div
                  className={cn('flex items-center gap-3', open.length > 0 && 'border-t pt-5')}
                  title={finished.map((step) => step.name).join(', ')}
                >
                  <StepLogoStack steps={finished} max={5} ringClassName="ring-background" />
                  <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                    <SolidCheckIcon className="text-kortix-green size-3.5 shrink-0" />
                    {t('doneSummary', { count: finished.length })}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Below `lg` the rail stacks on top, so its button moves under the work. */}
        <footer className="flex justify-end border-t px-6 py-3 lg:hidden">
          <Button size="sm" onClick={later}>
            {finishedOrEmpty ? t('done') : t('later')}
          </Button>
        </footer>
      </ModalContent>
    </Modal>
  );
}

function StepSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-muted-foreground flex items-baseline gap-1.5 text-xs">
        {title}
        <span className="tabular-nums">{count}</span>
      </h3>
      {children}
    </section>
  );
}

/** What a step's control needs: the step and what this viewer may do with it. */
interface StepView {
  projectId: string;
  canConnect: boolean;
  canSetSecrets: boolean;
  slackInstallUrl: string | null;
  refresh: () => void;
}

/** An open step: its logo, its name, and the one control that finishes it. */
function OpenStepTile({ view, step }: { view: StepView; step: SetupStep }) {
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-lg border py-2.5 pr-2.5 pl-3">
      <StepLogo step={step} size="md" />
      <p className={cn('text-foreground min-w-0 flex-1 truncate text-sm font-medium', step.kind === 'secret' && 'font-mono text-xs')}>
        {step.name}
      </p>
      <StepAction view={view} step={step} />
    </li>
  );
}

export function StepLogo({
  step,
  size = 'lg',
  className,
}: {
  step: SetupStep;
  size?: ConnectorLogoSize;
  className?: string;
}) {
  if (step.kind === 'connector') {
    return <ConnectorLogo source={installedConnectorLogoSource(step.connector)} size={size} className={className} />;
  }
  if (step.kind === 'slack') return <ConnectorLogo source={{ nativeApp: 'slack' }} size={size} className={className} />;
  const tile = { xs: 'size-5 rounded-sm', sm: 'size-6 rounded-sm', md: 'size-8 rounded-md', lg: 'size-9 rounded-md', xl: 'size-14 rounded-xl' }[size];
  const glyph = { xs: 'size-3', sm: 'size-3.5', md: 'size-4', lg: 'size-4', xl: 'size-6' }[size];
  return (
    <span className={cn('bg-muted flex shrink-0 items-center justify-center', tile, className)}>
      <KeyIcon className={cn('text-muted-foreground', glyph)} />
    </span>
  );
}

/**
 * Steps' logos as an overlapping stack, the rest as "+N". Every logo sits on
 * the same 28px tile, washed with its own colour: a blurred, scaled copy of
 * the logo at low opacity behind the mark. The logo hosts send no CORS
 * headers, so a canvas cannot read the colour; the browser blends it instead.
 * Each tile overlaps the one before it and is cut out of it by a ring in the
 * surface's own fill (`ringClassName`); the "+N" tile, last, is never hidden.
 */
export function StepLogoStack({
  steps,
  max = 3,
  ringClassName,
}: {
  steps: SetupStep[];
  max?: number;
  ringClassName: string;
}) {
  const shown = steps.slice(0, max);
  const more = steps.length - shown.length;
  // 7px corners on the 28px tile, 4px on the 18px mark inside it: between the
  // `rounded-sm` (6px) and `rounded-md` (8px) rungs by design (Jay, 2026-11-21),
  // the same curve at both sizes.
  const tile = cn('relative flex size-7 shrink-0 items-center justify-center rounded-[7px] ring-2', ringClassName); // audit:allow 7px logo tile, between rungs by request
  return (
    <AvatarGroup aria-hidden className="shrink-0 -space-x-1.5">
      {shown.map((step) => (
        <span key={step.id} className={cn(tile, 'bg-background isolate overflow-hidden')}>
          <LogoWash src={stepLogoImage(step)} />
          {/* The bare mark: the tile is its frame, so the logo's own border and fill go. */}
          <StepLogo step={step} size="xs" className="rounded-[4px] border-0 bg-transparent [&_img]:rounded-[4px]" /> {/* audit:allow 4px mark in the 7px tile; the img carries its own 6px */}
        </span>
      ))}
      {more > 0 ? (
        <AvatarGroupCount className={cn(tile, 'bg-muted text-muted-foreground w-auto min-w-7 px-1.5 text-xs font-medium tabular-nums')}>
          +{more}
        </AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

/** The step's logo image URL, or null for a drawn mark (Slack, a secret's key) that has no image to wash with. */
function stepLogoImage(step: SetupStep): string | null {
  if (step.kind !== 'connector') return null;
  const logo = resolveConnectorLogo(installedConnectorLogoSource(step.connector));
  return logo.kind === 'image' ? logo.src : null;
}

/** The logo's colour as a faint fill: the image itself, blurred past recognition. A drawn mark gets the muted fill. */
function LogoWash({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span aria-hidden className="bg-muted absolute inset-0 -z-10" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- third-party logos on arbitrary hosts; the Next loader adds nothing
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className="pointer-events-none absolute inset-0 -z-10 size-full scale-150 object-cover opacity-40 blur-sm select-none"
    />
  );
}

/** The words for one step: the verb that finishes it, whole or short. */
export function useStepCopy() {
  const t = useTranslations('workspaceSetup');
  return {
    action: (step: SetupStep) =>
      step.kind === 'connector'
        ? step.broken
          ? t('reconnect', { name: step.name })
          : t('connect', { name: step.name })
        : step.kind === 'secret'
          ? t('setSecret', { name: step.name })
          : t('addSlack'),
    /** The verb alone, for a row that already names the step. Slack keeps its own label. */
    short: (step: SetupStep) =>
      step.kind === 'connector'
        ? step.broken
          ? t('reconnectShort')
          : t('connectShort')
        : step.kind === 'secret'
          ? t('setShort')
          : undefined,
  };
}

/**
 * The control that finishes one step, or "Done". Hidden (not disabled) when
 * the viewer may not do it.
 */
function StepAction({ view, step }: { view: StepView; step: SetupStep }) {
  const t = useTranslations('workspaceSetup');
  const copy = useStepCopy();
  if (step.done) {
    return (
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
        <SolidCheckIcon className="text-kortix-green size-4 shrink-0" />
        {t('done')}
      </span>
    );
  }
  const label = copy.short(step);
  if (step.kind === 'connector') {
    return view.canConnect ? (
      <ConnectorAction
        projectId={view.projectId}
        connector={step.connector}
        name={step.name}
        broken={step.broken}
        onChanged={view.refresh}
        label={label ?? t('connect', { name: step.name })}
      />
    ) : null;
  }
  if (step.kind === 'secret') {
    return view.canSetSecrets ? (
      <SecretAction projectId={view.projectId} step={step} onChanged={view.refresh} label={label ?? t('setSecret', { name: step.name })} />
    ) : null;
  }
  return <SlackAction projectId={view.projectId} installUrl={view.slackInstallUrl} />;
}

/**
 * Connect: the shared account every agent of the workspace uses, signed in at
 * once, the same as the connector page's Add account with "Everyone". A
 * connector whose account broke opens its own page, where the account is.
 */
function ConnectorAction({
  projectId,
  connector,
  name,
  broken,
  onChanged,
  label,
}: {
  projectId: string;
  connector: AdminConnector;
  name: string;
  broken: boolean;
  onChanged: () => void;
  label: string;
}) {
  const [credential, setCredential] = useState<{ connectionId: string; owner: 'project' | 'me' } | null>(null);
  const add = useAddAccount({ projectId, connector, displayName: name, onAdded: onChanged, onCredential: setCredential });
  if (broken) {
    return (
      <Button asChild size="sm" variant="outline" aria-label={label}>
        <Link href={connectorHref(projectId, connector.slug)}>{label}</Link>
      </Button>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={add.pending}
        aria-busy={add.pending}
        onClick={() => add.submit({ label: add.proposedLabel(), audience: 'project', picked: { memberIds: [], groupIds: [] } })}
      >
        {label}
      </Button>
      {credential ? (
        <SetCredentialModal
          key={credential.connectionId}
          projectId={projectId}
          connector={connector}
          connectionId={credential.connectionId}
          owner={credential.owner}
          open
          onOpenChange={(open) => {
            if (!open) setCredential(null);
          }}
          onSaved={() => {
            setCredential(null);
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function SecretAction({
  projectId,
  step,
  onChanged,
  label,
}: {
  projectId: string;
  step: Extract<SetupStep, { kind: 'secret' }>;
  onChanged: () => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ProjectSecretDialog projectId={projectId} row={step.row} open={open} onOpenChange={setOpen} onSaved={onChanged} />
    </>
  );
}

/** One-click "Add to Slack" in a new tab when the host has the Slack app; else the Channels page, which takes a bot token. */
function SlackAction({ projectId, installUrl }: { projectId: string; installUrl: string | null }) {
  const t = useTranslations('workspaceSetup');
  return installUrl ? (
    <Button asChild size="sm" variant="outline">
      <a href={installUrl} target="_blank" rel="noopener noreferrer">
        {t('addSlack')}
      </a>
    </Button>
  ) : (
    <Button asChild size="sm" variant="outline">
      <Link href={`/workspaces/${projectId}/admin/connectors?scope=channels`}>{t('connectSlack')}</Link>
    </Button>
  );
}
