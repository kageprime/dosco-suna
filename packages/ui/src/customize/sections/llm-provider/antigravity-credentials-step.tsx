'use client';

import { KeyIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslations } from '../../../i18n';
import { Button } from '../../../primitives/button';
import { Textarea } from '../../../primitives/textarea';
import Loading from '../../../primitives/loading';
import { parseAntigravityAuth } from './antigravity-auth';
import { errorToast } from '../../../primitives/toast';

export function AntigravityCredentialsStep({
  saving,
  onSubmit,
}: {
  saving: boolean;
  onSubmit: (rawCreds: string) => void;
}) {
  const t = useTranslations('antigravitySubscription');
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseAntigravityAuth(value);
    if (!parsed || (!parsed.access && !parsed.refresh)) {
      errorToast('Invalid Antigravity credentials', {
        description: 'Paste a Google Antigravity OAuth JSON or a ya29. access token. A Gemini API key cannot be used here.',
      });
      return;
    }
    onSubmit(value.trim());
  };

  return (
    <div className="bg-muted/60 space-y-3 rounded-lg p-4" data-provider-antigravity="">
      <p className="text-muted-foreground text-xs text-pretty">
        Paste a Google Antigravity OAuth credential: the OAuth JSON from a Google Antigravity sign-in, or a{' '}
        <code className="text-foreground">ya29.</code> access token. A JSON with a refresh token stays connected; a raw
        access token lasts about 50 minutes. A Gemini API key cannot be used here.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Textarea
          autoFocus
          rows={3}
          spellCheck={false}
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          placeholder={'ya29.a0AfH6... or {"access_token": "ya29...", "refresh_token": "1//..."}'}
          className="font-mono text-xs"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <LockKeyIcon className="size-3 shrink-0" /> Credentials are encrypted and stored in your workspace
          </span>
          <Button type="submit" size="sm" disabled={!value.trim() || saving} className="gap-1.5">
            {saving ? <Loading className="size-3.5 shrink-0" /> : <KeyIcon className="size-3.5 shrink-0" />}
            {saving ? 'Connecting...' : 'Connect Antigravity'}
          </Button>
        </div>
      </form>
    </div>
  );
}
