'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { Github } from '@/features/icon/icons/github';
import { authRedirectUrl } from '@/lib/desktop';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

interface GitHubSignInProps {
  returnUrl?: string;
  referralCode?: string;
  mobileCallbackState?: string;
}

export default function GitHubSignIn({
  returnUrl,
  referralCode,
  mobileCallbackState,
}: GitHubSignInProps) {
  const [isLoading, setIsLoading] = useState(false);
  const supabase = createClient();
  const t = useTranslations('auth');

  const handleGitHubSignIn = async () => {
    try {
      setIsLoading(true);

      if (referralCode) {
        document.cookie = `pending-referral-code=${referralCode.trim().toUpperCase()}; path=/; max-age=600; SameSite=Lax`;
      }

      const callbackParams = new URLSearchParams();
      if (returnUrl) callbackParams.set('returnUrl', returnUrl);
      if (mobileCallbackState) {
        callbackParams.set('mobile_callback', '1');
        callbackParams.set('state', mobileCallbackState);
      }
      const callbackPath = `${mobileCallbackState ? '/auth/mobile/callback' : '/auth/callback'}${callbackParams.size ? `?${callbackParams.toString()}` : ''}`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          // Desktop: bounce back via the kortix:// scheme so the OS hands
          // the callback to the desktop app — same treatment as Google
          // (see google-signin.tsx).
          redirectTo: authRedirectUrl(callbackPath),
        },
      });

      if (error) {
        throw error;
      }
    } catch (error: any) {
      console.error('GitHub sign-in error:', error);
      errorToast(error.message || 'Failed to sign in with GitHub');
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleGitHubSignIn}
      disabled={isLoading}
      variant="secondary"
      size="lg"
      className="w-full"
      type="button"
    >
      {/* Loading defaults to `text-background` inside a button — correct on the
          primary (dark) button, invisible on this secondary one. */}
      {isLoading ? (
        <Loading className="text-foreground! size-4 shrink-0" />
      ) : (
        <Github className="size-4 shrink-0" />
      )}
      <span>{isLoading ? t('signingIn') : t('continueWithGitHub')}</span>
    </Button>
  );
}