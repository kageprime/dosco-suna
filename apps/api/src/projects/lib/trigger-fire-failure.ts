import { REPOSITORY_DISCONNECTED_CODE } from '../../shared/repository-health';

/**
 * Whether a failed scheduled fire is final on its first attempt. True when no
 * retry can change the outcome; false sends it back to the queue for the
 * normal retry budget.
 */
export function isTerminalFireFailure(
  result: { retryable?: boolean; errorCode?: string },
): boolean {
  // The fire said no retry can fix it (`retryable: false`: an App call the App
  // refused, a session that cannot exist, a channel the run may not post to).
  // A retry would fail the same way, so the first failure is the terminal one.
  return result.retryable === false
    // A billing-gate rejection (wallet drained / no plan / no account) is
    // PERMANENT — a retry re-runs the same `createSession` →
    // `checkBillingAdmission` only to fail identically, so retrying five times
    // over ~30s only delays the terminal state. Mark it terminal on the first
    // failure so the trigger runtime row shows `failed` + the machine-readable
    // reason immediately.
    || result.errorCode === 'insufficient_credits'
    || result.errorCode === 'subscription_required'
    || result.errorCode === 'no_account'
    // The model gate fails identically on every retry until the account
    // gains a usable model; retrying only delays the terminal state the
    // same way a billing rejection does.
    || result.errorCode === 'no_usable_model'
    // A model this account may not use (createSession's model gate): every
    // retry is refused the same way. Five tries a slot was 3,665 refused
    // creates a day for one project on prod (2026-11-02).
    || result.errorCode === 'INVALID_SESSION_MODEL'
    // The fire already paused the reminder; a retry cannot bring the session back.
    || result.errorCode === 'reminder_session_gone'
    // No retry reaches a repository until a person reconnects GitHub.
    || result.errorCode === REPOSITORY_DISCONNECTED_CODE;
}
