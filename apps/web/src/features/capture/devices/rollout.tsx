'use client';

import type { CaptureEnrollmentToken, CaptureEnrollmentTokenSecret } from '@kortix/sdk';
import {
  useCaptureEnrollmentTokens,
  useCreateCaptureEnrollmentToken,
  useRevokeCaptureEnrollmentToken,
} from '@kortix/sdk/react';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useId, useState } from 'react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { Switch } from '@kortix/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';

import { useCaptureDirectory } from '@kortix/ui/internal/capture/use-capture-area';
import {
  enrollmentUrl,
  errorText,
  EXPIRY_DAYS,
  expiryDate,
  installCommand,
  parseDomains,
  parseLimit,
  ROLLOUT_OS,
  type ExpiryDays,
  type RolloutOs,
} from './rollout-model';
import { CopyBlock } from '../copy-block';
import { MemberSelect } from './member-select';

export { WaitingComputers } from './waiting-computers';
export { LinkDeviceModal } from './link-device-modal';

/**
 * "Roll out to computers" (`capture.manage`): the enrollment tokens IT installs
 * Capture with, and a form for a new one. A new token is shown once,
 * with the silent install command.
 */
export function RolloutModal({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}) {
  const t = useTranslations('capture.rollout');
  const tokens = useCaptureEnrollmentTokens(open ? accountId : null);
  const [created, setCreated] = useState<CaptureEnrollmentTokenSecret | null>(null);
  // Revoked and expired tokens enroll nothing: kept out of sight until asked for.
  const [showInactive, setShowInactive] = useState(false);
  const all = tokens.data?.tokens ?? [];
  const inactive = all.filter((token) => token.state !== 'active');
  const shown = showInactive ? all : all.filter((token) => token.state === 'active');
  const close = (next: boolean) => {
    if (!next) setCreated(null);
    onOpenChange(next);
  };
  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-8 overflow-y-auto">
          {created ? (
            <CreatedToken token={created} />
          ) : (
            <NewTokenForm accountId={accountId} onCreated={setCreated} />
          )}
          <section className="space-y-3">
            <Label>{t('tokensTitle')}</Label>
            {tokens.isLoading ? (
              <Skeleton className="h-16 rounded-md" />
            ) : shown.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('tokensEmpty')}</p>
            ) : (
              <ul className="bg-popover divide-border divide-y rounded-md border">
                {shown.map((token) => (
                  <TokenRow key={token.token_id} accountId={accountId} token={token} />
                ))}
              </ul>
            )}
            {inactive.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowInactive((v) => !v)}
              >
                {showInactive ? t('hideRevoked') : t('showRevoked', { count: inactive.length })}
              </Button>
            ) : null}
          </section>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button asChild variant="ghost" size="sm" className="gap-1.5">
            <Link href="/docs/capture/rollout" target="_blank" rel="noopener noreferrer">
              {t('guide')}
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
          <Button size="sm" onClick={() => close(false)}>
            {t('done')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function NewTokenForm({
  accountId,
  onCreated,
}: {
  accountId: string;
  onCreated: (token: CaptureEnrollmentTokenSecret) => void;
}) {
  const t = useTranslations('capture.rollout');
  const create = useCreateCaptureEnrollmentToken(accountId);
  const ids = { name: useId(), person: useId(), domains: useId(), limit: useId(), approval: useId() };
  const [name, setName] = useState('');
  const [person, setPerson] = useState<string | null>(null);
  const [domains, setDomains] = useState('');
  const [limit, setLimit] = useState('');
  const [expiry, setExpiry] = useState<ExpiryDays>(30);
  const [approval, setApproval] = useState(false);
  const submit = () =>
    create.mutate(
      {
        name: name.trim(),
        email_domains: person ? [] : parseDomains(domains),
        max_devices: parseLimit(limit),
        require_approval: approval,
        expires_in_days: expiry,
        user_id: person,
      },
      { onSuccess: onCreated, onError: (error) => errorToast(errorText(error, t('createFailed'))) },
    );
  return (
    <section className="space-y-3">
      <Label>{t('newTitle')}</Label>
      <div className="bg-popover divide-border divide-y rounded-md border">
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <span>
            <Label htmlFor={ids.name} className="text-sm font-medium">
              {t('name')}
            </Label>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('nameHint')}</p>
          </span>
          <Input
            id={ids.name}
            value={name}
            maxLength={100}
            placeholder={t('namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <span>
            <p id={ids.person} className="text-sm font-medium">
              {t('for')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('forHint')}</p>
          </span>
          <MemberSelect
            accountId={accountId}
            enabled
            value={person}
            noneLabel={t('forAnyone')}
            labelledBy={ids.person}
            onChange={(next) => {
              setPerson(next);
              // A personal token installs that person's computer: cap it at one unless the admin says more.
              setLimit(next ? '1' : '');
            }}
          />
        </div>
        {person ? null : (
          <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
            <span>
              <Label htmlFor={ids.domains} className="text-sm font-medium">
                {t('domains')}
              </Label>
              <p className="text-muted-foreground mt-0.5 text-xs">{t('domainsHint')}</p>
            </span>
            <Input
              id={ids.domains}
              value={domains}
              placeholder={t('domainsPlaceholder')}
              onChange={(event) => setDomains(event.target.value)}
            />
          </div>
        )}
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <span>
            <Label htmlFor={ids.limit} className="text-sm font-medium">
              {t('limit')}
            </Label>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('limitHint')}</p>
          </span>
          <Input
            id={ids.limit}
            type="number"
            min={1}
            value={limit}
            placeholder="20"
            className="w-28 tabular-nums"
            onChange={(event) => setLimit(event.target.value)}
          />
        </div>
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
          <p className="text-sm font-medium">{t('expires')}</p>
          <Select
            value={String(expiry)}
            onValueChange={(value) =>
              setExpiry(value === 'null' ? null : (Number(value) as ExpiryDays))
            }
          >
            <SelectTrigger size="sm" aria-label={t('expires')} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_DAYS.map((days) => (
                <SelectItem key={String(days)} value={String(days)}>
                  {days === null ? t('never') : t('days', { days })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p id={ids.approval} className="text-foreground text-sm font-medium">
              {t('approval')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{t('approvalHint')}</p>
          </div>
          <Switch aria-labelledby={ids.approval} checked={approval} onCheckedChange={setApproval} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!name.trim() || create.isPending}
          aria-busy={create.isPending}
          onClick={submit}
        >
          {create.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {t('create')}
        </Button>
      </div>
    </section>
  );
}

/** The new token, once: the secret and the silent install command, each copyable. */
function CreatedToken({ token }: { token: CaptureEnrollmentTokenSecret }) {
  const t = useTranslations('capture.rollout');
  const url = enrollmentUrl(getEnv().BACKEND_URL);
  const [os, setOs] = useState<RolloutOs>('windows');
  return (
    <section className="space-y-3" aria-live="polite">
      <Label>{t('createdTitle', { name: token.name })}</Label>
      <p className="text-muted-foreground text-xs text-pretty">{t('createdBody')}</p>
      <CopyBlock text={token.token} copyLabel={t('copy')} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('installTitle')}</p>
        <Tabs value={os} onValueChange={(value) => setOs(value as RolloutOs)}>
          <TabsList size="xs" aria-label={t('installTitle')}>
            {ROLLOUT_OS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {t(`os.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <CopyBlock text={installCommand(os, url, token.token)} copyLabel={t('copy')} />
      <p className="text-muted-foreground text-xs text-pretty">{t(`installBody.${os}`)}</p>
    </section>
  );
}

function TokenRow({ accountId, token }: { accountId: string; token: CaptureEnrollmentToken }) {
  const t = useTranslations('capture.rollout');
  const locale = useLocale();
  const revoke = useRevokeCaptureEnrollmentToken(accountId);
  const [confirm, setConfirm] = useState(false);
  const people = useCaptureDirectory(accountId, token.user_id !== null);
  const person = token.user_id
    ? (people.members.find((member) => member.user_id === token.user_id)?.email ?? token.user_id)
    : null;
  const usage =
    token.max_devices === null
      ? t('usage', { count: token.device_count })
      : t('usageOf', { count: token.device_count, max: token.max_devices });
  const expiry = token.expires_at
    ? t(token.state === 'expired' ? 'expired' : 'expiresIn', {
        time: expiryDate(token.expires_at, locale),
      })
    : t('noExpiry');
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-foreground flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{token.name}</span>
          {token.state === 'active' ? null : (
            <Badge variant="outline" size="xs">
              {t(`state.${token.state}`)}
            </Badge>
          )}
          {token.require_approval ? (
            <Badge variant="outline" size="xs">
              {t('approvalBadge')}
            </Badge>
          ) : null}
        </p>
        <p className="text-muted-foreground mt-0.5 truncate text-xs tabular-nums">
          <code className="font-mono">{token.token_prefix}…</code> · {usage} ·{' '}
          {person
            ? t('forPerson', { person })
            : token.email_domains.length
              ? token.email_domains.join(', ')
              : t('anyDomain')}{' '}
          · {expiry}
        </p>
      </div>
      {token.state === 'active' ? (
        <Button variant="outline-ghost" size="sm" onClick={() => setConfirm(true)}>
          {t('revoke')}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('revokeTitle', { name: token.name })}
        description={t('revokeBody')}
        confirmLabel={t('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(token.token_id, {
            onSuccess: () => {
              successToast(t('revoked'));
              setConfirm(false);
            },
            onError: (error) => errorToast(errorText(error, t('revokeFailed'))),
          })
        }
      />
    </li>
  );
}
