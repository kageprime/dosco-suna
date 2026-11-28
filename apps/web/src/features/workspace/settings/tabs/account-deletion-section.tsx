'use client';
import { useAccountsList } from '@kortix/ui/internal/hooks/account/use-accounts-list';
import { useLocale } from '@/i18n/use-translations';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { getPersonDeletionPlan } from '@kortix/sdk';
import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Alert as BannerAlert, AlertTitle as BannerAlertTitle, AlertDescription as BannerAlertDescription} from '@kortix/ui/alert';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { useAccountDeletionStatus, useCancelAccountDeletion, useDeleteAccountImmediately, useRequestAccountDeletion } from '@/hooks/account/use-account-deletion';

type DeletionType = 'grace-period' | 'immediate';
export interface ProfileTabCopy {
  profilePicture: string;
  profilePictureDescription: string;
  remove: string;
  uploadProfilePicture: string;
  email: string;
  emailDescription: string;
  name: string;
  nameDescription: string;
  namePlaceholder: string;
  save: string;
  dangerZone: string;
  deleteAccount: string;
  plan: DeletionPlanCopy;
  deletionUnavailable: string;
  deletionStatusCheckFailed: string;
  scheduledForDeletionOn: string;
  scheduledForDeletion: string;
  cancelBeforeDeletion: string;
  deletionDescription: string;
  unavailable: string;
  retry: string;
  keepMyAccount: string;
  deleteDialogTitle: string;
  immediateWarning: string;
  gracePeriodWarning: string;
  whenDeleted: string;
  agentsDeleted: string;
  threadsDeleted: string;
  credentialsDeleted: string;
  subscriptionCancelled: string;
  billingRecordsKept: string;
  chooseWhen: string;
  gracePeriodLabel: string;
  gracePeriodDescription: string;
  immediateLabel: string;
  immediateDescription: string;
  noWorkspaceImmediateOnly: string;
  typeDeleteToConfirm: string;
  keepAccount: string;
  processing: string;
  keepAccountTitle: string;
  keepAccountDescription: string;
}
export const DEFAULT_PROFILE_TAB_COPY: ProfileTabCopy = {
  profilePicture: 'Profile picture',
  profilePictureDescription: 'JPG, PNG, or GIF. Max 5MB.',
  remove: 'Remove',
  uploadProfilePicture: 'Upload profile picture',
  email: 'Email',
  emailDescription: 'Used to sign in — cannot be changed here.',
  name: 'Name',
  nameDescription: 'Your display name across Kortix.',
  namePlaceholder: 'Your name',
  save: 'Save',
  dangerZone: 'Danger zone',
  deleteAccount: 'Delete account',
  plan: {
    deleted: 'Deleted with your account',
    left: 'You leave',
    blockersTitle: 'Hand these over first',
    blockers: 'You are their only owner, and others work in them. Transfer ownership or delete the workspace.',
    members: (count) => `${count} members`,
    nothing: 'No workspace is deleted or left with your account.',
  },
  deletionUnavailable:
    "Account deletion isn't available on this deployment. Contact support to close your account.",
  deletionStatusCheckFailed: "Couldn't confirm whether account deletion is available.",
  scheduledForDeletionOn: 'Scheduled for deletion on {date}.',
  scheduledForDeletion: 'Scheduled for deletion.',
  cancelBeforeDeletion: 'You can cancel any time before then.',
  deletionDescription: 'Schedule account deletion. You can cancel before the scheduled date.',
  unavailable: 'Unavailable',
  retry: 'Retry',
  keepMyAccount: 'Keep my account',
  deleteDialogTitle: 'Delete your account?',
  immediateWarning:
    'This deletes your account right away. There is no grace period and no way to undo it.',
  // Conditional, not present tense: nothing is scheduled yet while this
  // dialog is open — the line describes what choosing the option does
  // (KRTX-1403: "is scheduled" read as an already-scheduled deletion while
  // GET /v1/account/deletion-status reported none).
  gracePeriodWarning:
    'Your account will be scheduled for deletion after a grace period. You can cancel before the scheduled date.',
  whenDeleted: 'When your account is deleted:',
  agentsDeleted: 'Every agent you own is deleted',
  threadsDeleted: 'Every thread and message is deleted',
  credentialsDeleted: 'Every credential and secret is removed',
  subscriptionCancelled: 'Your subscription is cancelled',
  billingRecordsKept: 'Your billing records are kept as long as the law requires',
  chooseWhen: 'Choose when',
  gracePeriodLabel: 'Grace period',
  gracePeriodDescription: 'Deletion happens on the scheduled date. Cancel any time before then.',
  immediateLabel: 'Delete immediately',
  immediateDescription: 'Your account and its data are deleted right away. This cannot be undone.',
  noWorkspaceImmediateOnly:
    'You belong to no workspace, so there is no grace period: your account is deleted right away.',
  typeDeleteToConfirm: 'Type "delete" to confirm',
  keepAccount: 'Keep account',
  processing: 'Processing…',
  keepAccountTitle: 'Keep your account?',
  keepAccountDescription:
    'This cancels the scheduled deletion. Your account and its data stay exactly as they are.',
};

export interface AccountDeletionSectionViewProps {
  // Delete account
  /**
   * The person belongs to no workspace (Workspaces D3). The dialog stays the
   * same Delete-account dialog (KRTX-4849); only the grace period is disabled
   * with its reason, because `POST /v1/account/request-deletion` answers 409
   * `no_workspace` for them.
   */
  noWorkspace?: boolean;
  /**
   * What deleting the person does (`GET /v1/account/deletion-plan`): the
   * workspaces deleted with them (sole owner, only member), the ones they
   * leave, and the shared ones they must hand over first. `undefined` while
   * it loads.
   */
  deletionPlan?: ProfileDeletionPlan;
  accountDeletionSupported?: boolean;
  hasPendingDeletion?: boolean;
  deletionScheduledForLabel?: string | null;
  deletionPreviewDateLabel?: string | null;
  isDeletionStatusError?: boolean;
  onRetryDeletionStatus?: () => void;
  showDeleteDialog?: boolean;
  onOpenDeleteDialog?: () => void;
  onCloseDeleteDialog?: () => void;
  deletionType?: DeletionType;
  onDeletionTypeChange?: (value: DeletionType) => void;
  deleteConfirmText?: string;
  onDeleteConfirmTextChange?: (value: string) => void;
  onConfirmDelete?: () => void;
  isDeletingAccount?: boolean;
  showCancelDeletionDialog?: boolean;
  onOpenCancelDeletionDialog?: () => void;
  onCloseCancelDeletionDialog?: () => void;
  onConfirmCancelDeletion?: () => void;
  isCancelingDeletion?: boolean;
  copy?: Partial<ProfileTabCopy>;
}

/** What deleting the person does, with workspace names resolved for display. */
interface ProfileDeletionPlan {
  deleteNames: string[];
  leaveNames: string[];
  blockers: Array<{ name: string; memberCount: number }>;
}

interface DeletionPlanCopy {
  deleted: string;
  left: string;
  blockersTitle: string;
  blockers: string;
  members: (count: number) => string;
  nothing: string;
}

/** The plan, in three short lists: deleted, left, and the blockers that disable Delete. */
function DeletionPlanSummary({ plan, copy }: { plan: ProfileDeletionPlan; copy: DeletionPlanCopy }) {
  const empty = plan.deleteNames.length + plan.leaveNames.length + plan.blockers.length === 0;
  return (
    <div className="space-y-3" data-testid="deletion-plan">
      {empty ? <p className="text-muted-foreground text-sm">{copy.nothing}</p> : null}
      {plan.blockers.length > 0 ? (
        <BannerAlert variant="destructive" ><BannerAlertTitle>{copy.blockersTitle}</BannerAlertTitle><BannerAlertDescription>
          <p>{copy.blockers}</p>
          <ul className="list-disc space-y-1 pl-5">
            {plan.blockers.map((blocker) => (
              <li key={blocker.name}>
                {blocker.name} · {copy.members(blocker.memberCount)}
              </li>
            ))}
          </ul>
        </BannerAlertDescription></BannerAlert>
      ) : null}
      {plan.deleteNames.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{copy.deleted}</p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            {plan.deleteNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.leaveNames.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{copy.left}</p>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            {plan.leaveNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function AccountDeletionSectionView({
  noWorkspace = false,
  deletionPlan,
  accountDeletionSupported = true,
  hasPendingDeletion = false,
  deletionScheduledForLabel = null,
  deletionPreviewDateLabel = null,
  isDeletionStatusError = false,
  onRetryDeletionStatus = () => {},
  showDeleteDialog = false,
  onOpenDeleteDialog = () => {},
  onCloseDeleteDialog = () => {},
  deletionType = 'grace-period',
  onDeletionTypeChange = () => {},
  deleteConfirmText = '',
  onDeleteConfirmTextChange = () => {},
  onConfirmDelete = () => {},
  isDeletingAccount = false,
  showCancelDeletionDialog = false,
  onOpenCancelDeletionDialog = () => {},
  onCloseCancelDeletionDialog = () => {},
  onConfirmCancelDeletion = () => {},
  isCancelingDeletion = false,
  copy: copyOverrides = {},
}: AccountDeletionSectionViewProps) {
  const copy: ProfileTabCopy = { ...DEFAULT_PROFILE_TAB_COPY, ...copyOverrides };
  // The right-hand control of the Delete-account row, and the line under its
  // label. Four states, one row — an errored status check, an unavailable or
  // an already-scheduled deletion changes what the row SAYS and what its
  // control DOES, not which shape the pane is in. Before this, each state
  // replaced the row with a paragraph or a banner, so the pane's last block
  // moved as the state changed. Every gate is unchanged:
  // `accountDeletionSupported` is still the only thing that decides whether a
  // delete is offered at all. An errored status check is not an answer
  // (KRTX-2177): the row neither claims support nor borrows the unavailable
  // copy — that copy asserts a definitive fact about the deployment, which a
  // failed fetch cannot know. It states the check failed and offers Retry.
  // The check comes first so no later branch can render a destructive
  // control off an unknown answer.
  const deleteAccountDescription = noWorkspace
    ? copy.noWorkspaceImmediateOnly
    : isDeletionStatusError
    ? copy.deletionStatusCheckFailed
    : !accountDeletionSupported
      ? copy.deletionUnavailable
      : hasPendingDeletion
        ? `${
            deletionScheduledForLabel
              ? copy.scheduledForDeletionOn.replace('{date}', deletionScheduledForLabel)
              : copy.scheduledForDeletion
          } ${copy.cancelBeforeDeletion}`
        : copy.deletionDescription;

  // Danger zone
  return (
      <section className="space-y-3">
        <SettingsSubsectionHeader title={copy.dangerZone} />
        <SettingsRowGroup>
          <SettingsRow label={copy.deleteAccount} description={deleteAccountDescription}>
            {isDeletionStatusError ? (
              <Button variant="outline" size="sm" onClick={onRetryDeletionStatus}>
                {copy.retry}
              </Button>
            ) : !accountDeletionSupported ? (
              <span className="text-muted-foreground text-sm">{copy.unavailable}</span>
            ) : hasPendingDeletion ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onOpenCancelDeletionDialog}
                disabled={isCancelingDeletion}
              >
                {copy.keepMyAccount}
              </Button>
            ) : (
              /* Red text, not a filled button: the weight belongs to the
                 confirmation inside the modal, not to the affordance that
                 opens it. Same trigger as `general-tab.tsx`'s Delete
                 workspace. */
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onOpenDeleteDialog}
              >
                {copy.deleteAccount}
              </Button>
            )}
          </SettingsRow>
        </SettingsRowGroup>

        {accountDeletionSupported && (
          <>
            <Modal open={showDeleteDialog} onOpenChange={(open) => !open && onCloseDeleteDialog()}>
              <ModalContent className="lg:max-w-md" variant="base">
                <ModalHeader>
                  <ModalTitle>{copy.deleteDialogTitle}</ModalTitle>
                </ModalHeader>
                <ModalBody className="space-y-4">
                  <BannerAlert variant="warning" ><BannerAlertDescription>
                    {deletionType === 'immediate' ? (
                      copy.immediateWarning
                    ) : (
                      <>
                        {copy.gracePeriodWarning}
                        {deletionPreviewDateLabel && <p>{deletionPreviewDateLabel}</p>}
                      </>
                    )}
                  </BannerAlertDescription></BannerAlert>
                  {deletionPlan ? (
                    <DeletionPlanSummary plan={deletionPlan} copy={copy.plan} />
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{copy.whenDeleted}</p>
                      <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
                        <li>{copy.agentsDeleted}</li>
                        <li>{copy.threadsDeleted}</li>
                        <li>{copy.credentialsDeleted}</li>
                        <li>{copy.subscriptionCancelled}</li>
                        <li>{copy.billingRecordsKept}</li>
                      </ul>
                    </div>
                  )}
                  <div className="space-y-3">
                    <Label className="text-sm">{copy.chooseWhen}</Label>
                    <RadioGroup
                      value={deletionType}
                      onValueChange={(value) => onDeletionTypeChange(value as DeletionType)}
                    >
                      <RadioGroupItem
                        value="grace-period"
                        id="profile-grace-period"
                        label={copy.gracePeriodLabel}
                        description={noWorkspace ? copy.noWorkspaceImmediateOnly : copy.gracePeriodDescription}
                        disabled={noWorkspace}
                        size="lg"
                        variant="outline"
                      />
                      <RadioGroupItem
                        value="immediate"
                        id="profile-immediate"
                        label={copy.immediateLabel}
                        description={copy.immediateDescription}
                        size="lg"
                        variant="outline"
                      />
                    </RadioGroup>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-delete-confirm" className="text-sm">
                      {copy.typeDeleteToConfirm}
                    </Label>
                    <Input
                      type="text"
                      id="profile-delete-confirm"
                      value={deleteConfirmText}
                      onChange={(e) => onDeleteConfirmTextChange(e.target.value)}
                      // No placeholder: the word the user must type must not
                      // sit in the field before anything is typed. With a
                      // "delete" placeholder the dialog never looks empty, so
                      // a carried-over confirmation could not be seen
                      // (KRTX-1403). The label above already shows the word.
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </div>
                </ModalBody>
                <ModalFooter className="w-full sm:justify-between">
                  <Button
                    variant="outline-ghost"
                    onClick={onCloseDeleteDialog}
                    className="w-full sm:w-auto"
                  >
                    {copy.keepAccount}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={onConfirmDelete}
                    disabled={
                      isDeletingAccount ||
                      deleteConfirmText !== 'delete' ||
                      (deletionPlan?.blockers.length ?? 0) > 0
                    }
                    className="w-full sm:w-auto"
                  >
                    {isDeletingAccount ? copy.processing : copy.deleteAccount}
                  </Button>
                </ModalFooter>
              </ModalContent>
            </Modal>

            <ConfirmDialog
              open={showCancelDeletionDialog}
              onOpenChange={(open) => !open && onCloseCancelDeletionDialog()}
              title={copy.keepAccountTitle}
              description={copy.keepAccountDescription}
              confirmLabel={copy.keepMyAccount}
              onConfirm={onConfirmCancelDeletion}
              isPending={isCancelingDeletion}
            />
          </>
        )}
      </section>
  );
}

export function AccountDeletionSection({ copy }: { copy: ProfileTabCopy }) {
  const locale = useLocale();
  // --- Organizations ----------------------------------------------------
  // Same account-list entry `WorkspaceSwitcher` already primed on mount, so
  // this costs no extra request inside a project shell.
  // No account at all (Workspaces D3: nothing is created at sign-up). The
  // grace period then answers 409 `no_workspace`, and `delete-immediately`
  // deletes the person at once (flow DEL-6).
  const accountList = useAccountsList();
  const noWorkspace = accountList.isSuccess && (accountList.data ?? []).length === 0;

  // --- Delete account ---------------------------------------------------
  // The plan names every workspace the delete touches, read when the dialog
  // opens: deleted (sole owner, only member), left, and the blockers.
  const [planWanted, setPlanWanted] = useState(false);
  const planQuery = useQuery({
    queryKey: ['person-deletion-plan'],
    queryFn: getPersonDeletionPlan,
    enabled: planWanted,
    staleTime: 0,
  });
  const directory = useWorkspaceDirectory();
  const deletionPlan = useMemo<ProfileDeletionPlan | undefined>(() => {
    const plan = planQuery.data;
    if (!plan) return undefined;
    // The API names each workspace (`workspace_names`); the directory is the fallback.
    const served = plan.workspace_names ?? {};
    const nameOf = (id: string) =>
      served[id] ?? directory.workspaces.find((row) => row.workspaceId === id)?.project.name ?? id;
    return {
      deleteNames: plan.delete_workspaces.map(nameOf),
      leaveNames: plan.leave_workspaces.map(nameOf),
      blockers: plan.blockers.map((blocker) => ({ name: blocker.name, memberCount: blocker.member_count })),
    };
  }, [planQuery.data, directory.workspaces]);
  const {
    data: deletionStatus,
    isError: isDeletionStatusError,
    dataUpdatedAt: deletionStatusAnsweredAt,
    errorUpdatedAt: deletionStatusFailedAt,
    fetchStatus: deletionStatusFetchStatus,
    refetch: retryDeletionStatus,
  } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();
  const deleteImmediately = useDeleteAccountImmediately();
  // The API decides: its deletion-status route answers on every deployment
  // that deletes accounts, self-hosted ones included (billing on or off) — but
  // only a DEFINITIVE answer arms the row. The gate fails closed (KRTX-2177):
  // the old `?? !isCheckingDeletionStatus` mapped a rejected check — `data`
  // undefined, `isLoading` false — to "supported", arming the destructive
  // dialog against an endpoint of unknown state. `false` covers loading too:
  // the row already renders the unavailable shape while the check runs, and a
  // definitive `supported: false` answer renders the same shape, so neither
  // branch changes.
  const accountDeletionSupported = noWorkspace || deletionStatus?.supported === true;
  // "The freshest known outcome is a failure." A bare `isError` is not enough:
  // the moment a retry starts, query-core clears the error of a data-less query
  // (fetchState sets `status: 'pending'`), and the row would flash the
  // definitive "isn't available on this deployment" claim mid-retry — found
  // live against the local stack. `errorUpdatedAt > dataUpdatedAt` survives the
  // clearing: it stays true until a successful answer lands, so the failed
  // row (and its Retry) holds while the retry is in flight. The failed shape
  // is for an UNKNOWN answer only — `!deletionStatus`: on a failed refetch
  // query-core keeps the previous answer, and a user with a scheduled
  // deletion must keep that row (schedule + cancel) over a network blip.
  const isDeletionStatusFailed =
    !noWorkspace &&
    !deletionStatus &&
    (isDeletionStatusError ||
      (deletionStatusFetchStatus !== 'idle' && deletionStatusFailedAt > deletionStatusAnsweredAt));

  const [deletionPreviewDate, setDeletionPreviewDate] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCancelDeletionDialog, setShowCancelDeletionDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletionType, setDeletionType] = useState<DeletionType>('grace-period');

  // Every open starts the dialog fresh: no confirmation word and no carried
  // option from a previous attempt. Resetting here — not only on close —
  // holds no matter which path dismissed the dialog last time, the same
  // invariant `TypeToConfirmDialog` buys by mounting its body inside the
  // portal (KRTX-1403).
  const openDeleteDialog = () => {
    // Match the API's fourteen-day elapsed-time grace period.
    setDeletionPreviewDate(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString());
    setDeleteConfirmText('');
    setDeletionType(noWorkspace ? 'immediate' : 'grace-period');
    setPlanWanted(true);
    void planQuery.refetch();
    setShowDeleteDialog(true);
  };

  const closeDeleteDialog = () => {
    setShowDeleteDialog(false);
  };

  const handleConfirmDelete = async () => {
    try {
      if (deletionType === 'immediate') {
        await deleteImmediately.mutateAsync();
      } else {
        await requestDeletion.mutateAsync('User requested deletion');
      }
      closeDeleteDialog();
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  const handleConfirmCancelDeletion = async () => {
    try {
      await cancelDeletion.mutateAsync();
      setShowCancelDeletionDialog(false);
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }),
    [locale],
  );
  const formatDate = (dateString: string | null | undefined): string | null =>
    dateString ? dateFormat.format(new Date(dateString)) : null;

  return (
    <AccountDeletionSectionView
      noWorkspace={noWorkspace}
      deletionPlan={deletionPlan}
      accountDeletionSupported={accountDeletionSupported}
      hasPendingDeletion={!noWorkspace && (deletionStatus?.has_pending_deletion ?? false)}
      deletionScheduledForLabel={formatDate(deletionStatus?.deletion_scheduled_for)}
      deletionPreviewDateLabel={formatDate(deletionPreviewDate)}
      isDeletionStatusError={isDeletionStatusFailed}
      onRetryDeletionStatus={() => retryDeletionStatus()}
      showDeleteDialog={showDeleteDialog}
      onOpenDeleteDialog={openDeleteDialog}
      onCloseDeleteDialog={closeDeleteDialog}
      deletionType={deletionType}
      onDeletionTypeChange={setDeletionType}
      deleteConfirmText={deleteConfirmText}
      onDeleteConfirmTextChange={setDeleteConfirmText}
      onConfirmDelete={handleConfirmDelete}
      isDeletingAccount={requestDeletion.isPending || deleteImmediately.isPending}
      showCancelDeletionDialog={showCancelDeletionDialog}
      onOpenCancelDeletionDialog={() => setShowCancelDeletionDialog(true)}
      onCloseCancelDeletionDialog={() => setShowCancelDeletionDialog(false)}
      onConfirmCancelDeletion={handleConfirmCancelDeletion}
      isCancelingDeletion={cancelDeletion.isPending}
      copy={copy}
    />
  );
}
