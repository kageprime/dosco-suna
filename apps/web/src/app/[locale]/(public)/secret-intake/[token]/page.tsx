'use client';

import { SecretIntakeForm } from '@kortix/ui/markdown/setup-links/secret-intake-form';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';
import { useState } from 'react';

/** The quiet auth frame, like `/approve/[token]`: mark, left-aligned heading, the form. */
export default function SecretIntakePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);
  // A link that asks for a website login is titled as one.
  const [isLogin, setIsLogin] = useState(false);

  return (
    <AuthFrame footerVariant="none" art={false}>
      <Rise>
        <StepHeader
          title={
            isLogin
              ? tI18nHardcoded.raw('secretIntakeLogin.modalTitle')
              : tI18nHardcoded.raw('autoAppPublicSecretIntakeTokenPageJsxTextAddA71a8394a')
          }
          description={
            isLogin
              ? tI18nHardcoded.raw('secretIntakeLogin.pageDescription')
              : tI18nHardcoded.raw('autoAppPublicSecretIntakeTokenPageJsxTextEnterThec744a068')
          }
        />
      </Rise>
      <Rise delay={0.06}>
        {/* The header above already states the encryption promise. */}
        <SecretIntakeForm
          token={token}
          compact
          onLinkInfo={(info) => setIsLogin(info.scope === 'browser')}
        />
      </Rise>
    </AuthFrame>
  );
}
