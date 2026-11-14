'use client';

import { useTranslations } from '@/i18n/use-translations';

import { FormEvent, Suspense, useRef, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { FieldError, FieldLabel } from '@kortix/ui/internal/auth/auth-primitives';
import { AuthCardShell, BackToSignIn } from '@kortix/ui/internal/auth/auth-card-shell';
import { submitAuthForm } from '@/lib/auth/submit-auth';

function ForgotPasswordContent() {
  const t = useTranslations('auth.passwordReset');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setErrorMessage(null);
    setPending(true);

    const formData = new FormData(e.currentTarget);
    formData.set('origin', window.location.origin);
    const email = (formData.get('email') as string)?.trim();

    try {
      const outcome = await submitAuthForm('/api/auth/forgot-password', formData);
      if (outcome.ok && outcome.result.success) {
        setSentTo(email);
        return;
      }
      const message = outcome.ok ? outcome.result.message : outcome.message;
      const msg = typeof message === 'string' ? message : t('errors.sendFailed');
      setErrorMessage(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('errors.unexpected');
      setErrorMessage(msg);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (sentTo) {
    return (
      <AuthCardShell
        title={t('sent.title')}
        description={t.rich('sent.address', {
          email: sentTo,
          address: (chunks) => <span className="text-foreground wrap-break-word">{chunks}</span>,
        })}
        footer={<BackToSignIn />}
      />
    );
  }

  return (
    <AuthCardShell
      title={t('request.title')}
      description={t('request.description')}
      footer={<BackToSignIn />}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <FieldLabel htmlFor="email">{t('request.email')}</FieldLabel>
          <Input
            id="email"
            aria-invalid={!!errorMessage || undefined}
            name="email"
            type="email"
            size="md"
            placeholder={t('request.emailPlaceholder')}
            required
            autoComplete="email"
            autoFocus
            aria-describedby={errorMessage ? 'email-error' : undefined}
          />
          {errorMessage && <FieldError id="email-error" message={errorMessage} />}
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? t('request.sending') : t('request.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ForgotPassword() {
  const t = useTranslations('auth.passwordReset');
  return (
    <Suspense fallback={<ConnectingScreen minimal title={t('loading')} />}>
      <ForgotPasswordContent />
    </Suspense>
  );
}
