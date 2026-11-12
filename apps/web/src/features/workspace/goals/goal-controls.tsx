'use client';

import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { Alert as BannerAlert, AlertTitle as BannerAlertTitle, AlertDescription as BannerAlertDescription, AlertActions as BannerAlertActions, AlertMedia as BannerAlertMedia } from '@kortix/ui/alert';
import Loading from '@kortix/ui/loading';
import { infoToast, successToast } from '@kortix/ui/toast';
import { uiRoutes } from '@kortix/ui';
import { useTranslations } from '@/i18n/use-translations';
import { ProjectGoalConflictError, type ProjectGoal } from '@kortix/sdk';
import { useProjectGoalControl, type ProjectGoalControlInput } from '@kortix/sdk/react';
import { ChatCircleIcon, DotsThreeIcon, PauseIcon, PlayIcon, ShareNetworkIcon, StopIcon, WarningIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/** The goal page's control channel: one `useGoalActions` per page, and every control it drives. */


type GoalAction = ProjectGoalControlInput['action'];
const SUCCESS_TOAST: Record<GoalAction, string> = {
  pause: 'pausedToast',
  resume: 'resumedToast',
  stop: 'stoppedToast',
  restart: 'restartedToast',
  answer: 'answerSentToast',
};
const ERROR_TITLE: Record<GoalAction, string> = {
  pause: 'pauseError',
  resume: 'resumeError',
  stop: 'stopError',
  restart: 'restartError',
  answer: 'answerError',
};

type GoalActions = ReturnType<typeof useGoalActions>;

/**
 * One control channel for the page. `run` resolves true on success. A
 * conflict (the goal changed first) leaves the cache holding the current
 * goal and says so in a toast; any other failure is kept with its input, so
 * Retry sends the same control (an answer keeps its `answerId`: it lands once).
 */
function useGoalActions(projectId: string) {
  const t = useTranslations('goals');
  const control = useProjectGoalControl(projectId);
  const [failure, setFailure] = useState<{ input: ProjectGoalControlInput; message: string } | null>(null);
  const run = async (input: ProjectGoalControlInput): Promise<boolean> => {
    setFailure(null);
    try {
      await control.mutateAsync(input);
      if (input.action !== 'answer') successToast(t(SUCCESS_TOAST[input.action]));
      return true;
    } catch (error) {
      if (error instanceof ProjectGoalConflictError) infoToast(t('changedToast'));
      else setFailure({ input, message: error instanceof Error ? error.message : '' });
      return false;
    }
  };
  const pending: GoalAction | null = control.isPending ? (control.variables?.action ?? null) : null;
  return { run, pending, failure, retry: () => (failure ? run(failure.input) : Promise.resolve(false)), dismiss: () => setFailure(null) };
}

/** A control that failed: what failed, the server's reason, and a retry that sends it again. */
function ControlFailure({ actions }: { actions: GoalActions }) {
  const t = useTranslations('goals');
  const failure = actions.failure;
  if (!failure || failure.input.action === 'answer') return null;
  const retrying = actions.pending === failure.input.action;
  return (
    <BannerAlert variant="destructive" role="alert" data-testid="goal-control-error"><BannerAlertMedia><WarningIcon /></BannerAlertMedia><BannerAlertTitle>{t(ERROR_TITLE[failure.input.action])}</BannerAlertTitle><BannerAlertDescription>
      {failure.message || null}
    </BannerAlertDescription><BannerAlertActions>{<Button size="xs" variant="outline" className="gap-1.5" disabled={retrying} aria-busy={retrying} onClick={() => void actions.retry()} data-testid="goal-control-retry">
          {retrying ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('retry')}
        </Button>}</BannerAlertActions></BannerAlert>
  );
}

/** The one control a blocked goal offers, when the viewer may use it: resume after a fix, or start it again for a lost owner. */
function BlockedAction({ goal, actions }: { goal: ProjectGoal; actions: GoalActions }) {
  const t = useTranslations('goals');
  const action: 'resume' | 'restart' | null =
    goal.blockedReason === 'owner_lost' && goal.capabilities.restart
      ? 'restart'
      : (goal.blockedReason === 'credits' || goal.blockedReason === 'storage' || goal.blockedReason === 'flag_off') && goal.capabilities.resume
        ? 'resume'
        : null;
  if (!action) return null;
  const busy = actions.pending !== null;
  return (
    <Button
      size="xs"
      variant="outline"
      className="gap-1.5"
      disabled={busy}
      aria-busy={actions.pending === action}
      onClick={() => void actions.run(action === 'restart' ? { goal, action, reason: t('restartReason') } : { goal, action })}
    >
      {actions.pending === action ? <Loading className="size-3.5 shrink-0" /> : null}
      {action === 'restart' ? t('restart') : t('resume')}
    </Button>
  );
}

/**
 * The goal's controls, from `goal.capabilities` only: Pause, Resume or Start
 * again visible (the one frequent control), the rest in one menu: the chat,
 * sharing, and Stop (behind a confirm). While a control runs every control
 * is disabled: one request at a time, and the running one shows the spinner.
 */
function GoalControls({ projectId, goal, actions, onShare }: { projectId: string; goal: ProjectGoal; actions: GoalActions; onShare: () => void }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  const caps = goal.capabilities;
  const busy = actions.pending !== null;
  const sessionHref = goal.coordinatorSessionId ? uiRoutes().session(projectId, goal.coordinatorSessionId) : null;
  const control = (action: 'pause' | 'resume' | 'restart', icon: ReactNode, label: string) => (
    <Button
      size="xs"
      variant="secondary"
      className="gap-1.5"
      disabled={busy}
      aria-busy={actions.pending === action}
      onClick={() =>
        void actions.run(action === 'resume' ? { goal, action } : { goal, action, reason: t(action === 'pause' ? 'pauseReason' : 'restartReason') })
      }
      data-testid={`goal-${action}`}
    >
      {actions.pending === action ? <Loading className="size-3.5 shrink-0" /> : icon}
      {label}
    </Button>
  );

  return (
    <>
      {/* The visible control and the ⋯ menu: one secondary button group. */}
      <ButtonGroup>
        {caps.pause ? control('pause', <PauseIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />, t('pause')) : null}
        {caps.resume ? control('resume', <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />, t('resume')) : null}
        {caps.restart ? control('restart', <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />, t('restart')) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="secondary" aria-label={t('moreActions')} data-testid="goal-more">
              <DotsThreeIcon className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sessionHref ? (
              <DropdownMenuItem onSelect={() => router.push(sessionHref)}>
                <ChatCircleIcon aria-hidden />
                {t('openSession')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={onShare}>
              <ShareNetworkIcon aria-hidden />
              {t('share')}
            </DropdownMenuItem>
            {caps.stop ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setStopping(true)} data-testid="goal-stop">
                  <StopIcon aria-hidden />
                  {t('stop')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      <ConfirmDialog
        open={stopping}
        onOpenChange={(next) => actions.pending !== 'stop' && setStopping(next)}
        title={t('stopTitle')}
        description={t('stopDescription')}
        confirmLabel={t('stop')}
        confirmVariant="destructive"
        isPending={actions.pending === 'stop'}
        onConfirm={async () => {
          // Success or failure, the dialog closes: a failure shows its banner with a retry on the page.
          await actions.run({ goal, action: 'stop', reason: t('stopReason') });
          setStopping(false);
        }}
      />
    </>
  );
}

export { BlockedAction, ControlFailure, GoalControls, useGoalActions };
export type { GoalActions };
