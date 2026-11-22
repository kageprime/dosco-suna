'use client';

import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { useRef, useState } from 'react';

import type { KortixProject } from '@kortix/sdk';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { FieldError, FieldLabel } from '@kortix/ui/internal/auth/auth-primitives';
import { INITIAL_FORM_STATE, isSubmittable } from '@kortix/ui/workspace/new/new-workspace-form';
import { useCreateWorkspace } from '@kortix/ui/workspace/new/use-create-workspace';
import {
  suggestWorkspaceName,
  validateWorkspaceName,
  workspaceNameMessage,
} from '@kortix/ui/workspace/new/workspace-name';

/**
 * Create a workspace without leaving a pending CLI sign-in (KRTX-4940): the
 * chooser's name-only managed create, through the same `useCreateWorkspace`.
 *
 * It only creates. `onCreated` hands the new workspace to the page, which
 * selects it; the person still presses Authorize. No key is minted, no
 * callback is called and no device code is approved here. The page's query
 * (callback, state, label, user_code) is never touched, so a failure or a
 * cancel leaves the sign-in where it was.
 */
export function InlineCreateWorkspace({
  moreOptionsHref,
  onCreated,
  onCancel,
}: {
  /** `/workspaces/new` with a `returnUrl` back to this sign-in: the icon and the repository source. */
  moreOptionsHref: string;
  onCreated: (project: KortixProject) => void;
  /** Absent when creating is the only way forward (no workspace yet). */
  onCancel?: () => void;
}) {
  const tCli = useTranslations('workspaces.cli');
  const tChooser = useTranslations('workspaces.chooser');
  const tNew = useTranslations('newWorkspace');
  const tCommon = useTranslations('common');
  // A random name is safe in the initializer here: the page renders this form
  // only after the session loads, never on the server.
  const [name, setName] = useState(suggestWorkspaceName);
  const [touched, setTouched] = useState(false);
  const { create, status, error, retry, canRetry } = useCreateWorkspace({
    enterProject: (_projectId, project) => onCreated(project),
  });
  const creating = status === 'creating';
  const state = { ...INITIAL_FORM_STATE, name };
  const nameError = workspaceNameMessage(validateWorkspaceName(name), touched, tNew);
  // Synchronous guard: two submits before the re-render that disables the
  // button would start two creates.
  const inFlightRef = useRef(false);

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="cli-create-workspace"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (creating || inFlightRef.current || !isSubmittable(state)) return;
        inFlightRef.current = true;
        void create(state).finally(() => {
          inFlightRef.current = false;
        });
      }}
    >
      <FieldLabel htmlFor="cli-workspace-name">{tNew('name.label')}</FieldLabel>
      <Input
        id="cli-workspace-name"
        size="md"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        value={name}
        readOnly={creating}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => setTouched(true)}
        placeholder={tNew('name.placeholder')}
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? 'cli-workspace-name-error' : undefined}
      />
      {nameError ? <FieldError id="cli-workspace-name-error" message={nameError} /> : null}
      <div className="flex gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" size="lg" className="flex-1" disabled={creating} onClick={onCancel}>
            {tCommon('cancel')}
          </Button>
        ) : null}
        <Button type="submit" size="lg" className="flex-1" disabled={creating || !isSubmittable(state)}>
          {creating ? <Loading className="size-4 shrink-0" /> : null}
          {tCli('createAction')}
        </Button>
      </div>
      {status === 'error' && error ? (
        <div role="alert" className="flex flex-col items-center gap-1.5">
          <p className="text-destructive text-center text-xs">{error}</p>
          {canRetry ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={retry}
            >
              {tNew('actions.tryAgain')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {creating ? null : (
        <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground self-center">
          <Link href={moreOptionsHref}>{tChooser('moreOptions')}</Link>
        </Button>
      )}
    </form>
  );
}
