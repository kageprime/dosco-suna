'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { FieldError, FieldLabel } from '@kortix/ui/internal/auth/auth-primitives';
import { AuthCardShell, BackToSignIn } from '@kortix/ui/internal/auth/auth-card-shell';
import { resetPassword } from '../actions';

function ResetPasswordContent() {
  const t = useTranslations('auth.passwordReset');
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get('code');

  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setPending(true);
    try {
      const result = await resetPassword(null, new FormData(e.currentTarget));
      if (result && typeof result === 'object' && 'success' in result && result.success) {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        router.replace(url.pathname + url.search + url.hash);
        setSuccess(true);
        return;
      }
      const msg = (result as any)?.message || t('errors.updateFailed');
      setErrorMessage(msg);
    } catch (err: any) {
      const msg = err?.message || t('errors.unexpected');
      setErrorMessage(msg);
    } finally {
      setPending(false);
    }
  };

  // Link missing / expired — guide the user to request a fresh one instead of
  // dead-ending on an error.
  if (!code && !success) {
    return (
      <AuthCardShell
        title={t('expired.title')}
        description={t('expired.description')}
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/auth/forgot-password">{t('expired.requestNew')}</Link>
        </Button>
      </AuthCardShell>
    );
  }

  if (success) {
    return (
      <AuthCardShell
        title={t('success.title')}
        description={t('success.description')}
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/auth">{t('success.signIn')}</Link>
        </Button>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('form.title')}
      description={t('form.description')}
      footer={<BackToSignIn />}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <FieldLabel htmlFor="password">{t('form.newPassword')}</FieldLabel>
          <Input
            id="password"
            aria-invalid={!!errorMessage || undefined}
            name="password"
            type="password"
            size="md"
            placeholder={t('form.newPasswordPlaceholder')}
            required
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="space-y-3">
          <FieldLabel htmlFor="confirmPassword">{t('form.confirmPassword')}</FieldLabel>
          <Input
            id="confirmPassword"
            aria-invalid={!!errorMessage || undefined}
            name="confirmPassword"
            type="password"
            size="md"
            placeholder={t('form.confirmPasswordPlaceholder')}
            required
            autoComplete="new-password"
            aria-describedby={errorMessage ? 'password-error' : undefined}
          />
          {errorMessage && <FieldError id="password-error" message={errorMessage} />}
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? t('form.updating') : t('form.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ResetPassword() {
  const t = useTranslations('auth.passwordReset');
  return (
    <Suspense fallback={<ConnectingScreen minimal title={t('resetting')} />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
