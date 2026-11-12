'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useRevokeCaptureDevice } from '@kortix/sdk/react';
import { DotsThreeIcon, InfoIcon, LinkIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useTranslations } from '@/i18n/use-translations';

import { DeviceDetailsModal } from './device-details';
import { LinkDeviceModal } from './link-device-modal';

/**
 * A device's actions: its details (everyone who sees the device), link it to a
 * person (`capture.manage`), revoke it (asks first; your own, or any with
 * `capture.manage`; the API refuses others).
 */
export function DeviceActionsMenu({
  accountId,
  device,
  name,
  canLink = false,
  canRevoke = true,
  onRevoked,
}: {
  accountId: string;
  device: CaptureDevice;
  name: string;
  /** `capture.manage`: link the device to a person, or unlink it. */
  canLink?: boolean;
  /** Your own device, or `capture.manage`. */
  canRevoke?: boolean;
  onRevoked?: () => void;
}) {
  const t = useTranslations('capture.devices');
  const revoke = useRevokeCaptureDevice(accountId);
  const [confirm, setConfirm] = useState(false);
  const [linking, setLinking] = useState(false);
  const [details, setDetails] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-base" variant="ghost" aria-label={t('actionsFor', { name })}>
            <DotsThreeIcon className="size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => setDetails(true)}>
            <InfoIcon className="size-3.5 shrink-0" />
            {t('details.open')}
          </DropdownMenuItem>
          {canLink ? (
            <DropdownMenuItem onSelect={() => setLinking(true)}>
              <LinkIcon className="size-3.5 shrink-0" />
              {device.user_id ? t('relink') : t('link')}
            </DropdownMenuItem>
          ) : null}
          {canRevoke ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
              <ProhibitIcon className="size-3.5 shrink-0" />
              {t('revoke')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeviceDetailsModal device={details ? device : null} name={name} onClose={() => setDetails(false)} />
      {canLink ? (
        <LinkDeviceModal
          accountId={accountId}
          device={linking ? device : null}
          name={name}
          onClose={() => setLinking(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('revokeTitle')}
        description={t('revokeDescription', { name })}
        confirmLabel={t('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(device.device_id, {
            onSuccess: () => {
              successToast(t('revoked'));
              setConfirm(false);
              onRevoked?.();
            },
            onError: () => errorToast(t('revokeFailed')),
          })
        }
      />
    </>
  );
}
