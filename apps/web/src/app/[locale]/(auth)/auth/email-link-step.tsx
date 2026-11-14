'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { EmailFlowMode } from '@/lib/auth/unified-auth-flow';
import {
  CodeInput,
  FieldError,
  InfoStrip,
  QuietLinks,
  StepHeader,
} from '@kortix/ui/internal/auth/auth-primitives';
import Loading from '@kortix/ui/loading';
import { m, useReducedMotion } from 'motion/react';

const EASE = [0.23, 1, 0.32, 1] as const;

export function EmailLinkStep({
  sentEmail,
  errorMessage,
  info,
  resendIn,
  pending,
  pendingAction,
  passwordEnabled,
  /** The flow mode the send action resolved: 'signup' names the signup
   * confirmation email GoTrue minted; 'unknown' the send whose email kind
   * only the mailbox knows (sign-in link or confirmation, KRTX-3504 — the
   * API no longer says which); 'closed' a sign-in-only send that reaches the
   * mailbox only when the account exists. Anything else keeps the generic
   * link copy (KRTX-2516's fail-open). */
  mode,
  onResend,
  onChangeEmail,
  onPassword,
  code,
  onCodeChange,
  onVerify,
}: {
  sentEmail: string | null;
  errorMessage: string | null;
  info: string | null;
  resendIn: number;
  pending: boolean;
  pendingAction: 'continue' | 'link' | 'resend' | 'password' | 'sso' | null;
  passwordEnabled: boolean;
  mode?: EmailFlowMode;
  onResend: () => void;
  onChangeEmail: () => void;
  onPassword: () => void;
  code?: string;
  onCodeChange?: (value: string) => void;
  /** Verifies the typed code; the six-box input passes the code it just completed. */
  onVerify?: (value?: string) => void;
}) {
  const t = useTranslations('auth.unified');
  // The copy must name the email the mailbox receives (KRTX-2195): a signup
  // gets the confirmation email, so "a link" read the mail as the wrong
  // message. KRTX-3504: the API no longer says whether the address holds an
  // account, so an eligible send ('unknown') reaches mailboxes as EITHER kind
  // — the copy names both; a closed-signup send ('closed') mails a sign-in
  // link only when the account exists — the copy claims nothing more. Any
  // other mode keeps the generic link copy (KRTX-2516's fail-open).
  const descriptionKey =
    mode === 'unknown'
      ? 'link.unknownDescription'
      : mode === 'closed'
        ? 'link.closedDescription'
        : 'link.description';
  const confirmed = mode === 'signup';
  const prefersReducedMotion = useReducedMotion();
  const rise = (delay = 0) => ({
    initial: { opacity: 0, y: prefersReducedMotion ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay, ease: EASE },
  });
  return (
    <>
      <m.div {...rise(0)}>
        <StepHeader
          title={t('link.title')}
          description={t.rich(confirmed ? 'link.confirmDescription' : descriptionKey, {
            email: sentEmail ?? '',
            address: (chunks) => (
              <span className="text-foreground font-medium wrap-break-word">{chunks}</span>
            ),
          })}
        />
      </m.div>

      <m.div {...rise(0.06)}>
        {info && <InfoStrip message={info} />}

        {onCodeChange && onVerify && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onVerify();
            }}
          >
            {/* No submit button: the code verifies itself on the sixth digit. */}
            <div className="space-y-3">
              <CodeInput
                value={code ?? ''}
                onChange={onCodeChange}
                onComplete={(value) => onVerify(value)}
                disabled={pending}
                invalid={!!errorMessage}
              />
              {errorMessage && <FieldError id="code-error" message={errorMessage} />}
              {/* Always mounted: a live region that arrives with its text is
                  not announced by every screen reader. */}
              <p role="status" className="text-muted-foreground flex items-center gap-2 text-xs empty:hidden">
                {pendingAction === 'continue' ? (
                  <>
                    <Loading className="text-muted-foreground size-3.5 shrink-0" />
                    {t('oneMoment')}
                  </>
                ) : null}
              </p>
            </div>
          </form>
        )}
        {errorMessage && !(onCodeChange && onVerify) && (
          <FieldError id="code-error" message={errorMessage} />
        )}

        <QuietLinks
          disabled={pending}
          links={[
            { key: 'email', label: t('useDifferentEmail'), onClick: onChangeEmail },
            passwordEnabled
              ? {
                  key: 'password',
                  label: pendingAction === 'password' ? t('oneMoment') : t('usePasswordInstead'),
                  onClick: onPassword,
                }
              : null,
            // Plain text while the countdown runs, then the resend action.
            resendIn > 0
              ? { key: 'resend', label: t('link.resendIn', { seconds: resendIn }) }
              : {
                  key: 'resend',
                  label: pendingAction === 'resend' ? t('sending') : t('link.resend'),
                  onClick: onResend,
                },
          ]}
        />
      </m.div>
    </>
  );
}
