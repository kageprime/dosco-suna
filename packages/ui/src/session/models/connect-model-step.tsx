'use client';

import { CreditCardIcon, KeyIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { AuthFrame } from '../../internal/auth/auth-card-shell';
import { Rise, StepHeader } from '../../internal/auth/auth-primitives';
import { useAccountState } from '../../internal/billing/use-account-state';
import { Button } from '../../primitives/button';
import { UiLink } from '../../providers/ui-provider';
import { ModelConnectionLayoutContext } from './model-connection-layout';
import { ConnectPlanRows } from './subscription-offer';
import { useModelConnectionGate } from './use-model-connection-gate';

/** Where "Back to workspaces" goes: the chooser, never the door that reopens this workspace. */
export const CONNECT_MODEL_STEP_BACK_HREF = '/workspaces';

/**
 * The "Connect a model" step: what every workspace page shows while the viewer
 * can run no model (`useWorkspaceModelGate`). New workspaces land here right
 * after setup, and the workspace opens on its own once a model works: the
 * provider dialog's save refreshes the model list the gate reads.
 *
 * - The two plan tiles first (ChatGPT, Claude): most people already pay for
 *   one, and each opens the provider dialog with that provider expanded.
 * - "Add provider key" opens the same dialog on its provider list.
 * - "Upgrade plan" only for a viewer who may change the project's models,
 *   when the workspace's plan has no Kortix models
 *   (`model_access.requires_provider_key`) and billing is on.
 * - Every member gets the tiles and the key: the gate is per viewer, and a
 *   member may connect a login or a key for themselves (the server refuses
 *   only a connection shared with everyone, 403). A member who cannot change
 *   the project's models also reads who can connect one for everyone.
 *
 * There is no skip: with no model, nothing in the workspace can run. "Back to
 * workspaces" is the way out, to another workspace or to Log out.
 *
 * The host mounts the upgrade dialog (`GlobalUpgradeModal` in `apps/web`):
 * "Upgrade plan" opens it through the upgrade store.
 */
export function ConnectModelStep({
  projectId,
  workspaceName,
}: {
  projectId: string;
  workspaceName: string | null | undefined;
}) {
  const t = useTranslations('sessionUi.modelGate');
  const { canWriteProviders, openConnectProvider, openUpgrade, showUpgradeOption, modal } =
    useModelConnectionGate(undefined, { projectId });
  const accountState = useAccountState();
  const offerUpgrade =
    canWriteProviders &&
    showUpgradeOption &&
    accountState.data?.model_access?.requires_provider_key === true;

  const name = workspaceName?.trim() || t('stepThisWorkspace');
  const description = canWriteProviders
    ? t(offerUpgrade ? 'stepBodyUpgrade' : 'stepBody', { workspace: name })
    : t('stepBodyMember', { workspace: name });

  return (
    <AuthFrame footerVariant="none" backHref={CONNECT_MODEL_STEP_BACK_HREF}>
      {modal}
      <Rise key="connect-model-header">
        <StepHeader title={t('stepTitle')} description={description} />
      </Rise>
      <Rise key="connect-model-body" delay={0.06}>
        <div className="flex flex-col gap-5" data-testid="connect-model-step">
          {/* `above`: bordered tiles, the plan on a second line. One column at
              this frame's width, so each tile keeps its whole label. */}
          <ModelConnectionLayoutContext.Provider value="above">
            <ConnectPlanRows projectId={projectId} dismissible={false} className="sm:grid-cols-1" />
          </ModelConnectionLayoutContext.Provider>
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full gap-1.5"
              onClick={() => openConnectProvider('providers')}
            >
              <KeyIcon className="size-4 shrink-0" />
              {t('noModelAddProviderKey')}
            </Button>
            {offerUpgrade ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full gap-1.5"
                onClick={openUpgrade}
              >
                <CreditCardIcon className="size-4 shrink-0" />
                {t('noModelUpgradePlan')}
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="lg" className="w-full">
              <UiLink href={CONNECT_MODEL_STEP_BACK_HREF}>{t('stepBack')}</UiLink>
            </Button>
          </div>
        </div>
      </Rise>
    </AuthFrame>
  );
}
