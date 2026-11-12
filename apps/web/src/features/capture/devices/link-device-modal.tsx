'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useLinkCaptureDevice } from '@kortix/sdk/react';
import { useState } from 'react';

import { Button } from '@kortix/ui/button';
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
import { errorToast, successToast } from '@kortix/ui/toast';
import { useTranslations } from '@/i18n/use-translations';

import { errorText } from './rollout-model';
import { MemberSelect } from './member-select';

/**
 * Link a device to a Kortix user, or unlink it (`capture.manage`). What it
 * recorded linked to no one moves to the person; what it recorded for an
 * earlier person stays theirs.
 */
export function LinkDeviceModal({
  accountId,
  device,
  name,
  onClose,
}: {
  accountId: string;
  device: CaptureDevice | null;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('capture.rollout');
  const link = useLinkCaptureDevice(accountId);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const userId = picked === undefined ? (device?.user_id ?? null) : picked;
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  return (
    <Modal open={device !== null} onOpenChange={(open) => (open ? null : close())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('linkTitle', { name })}</ModalTitle>
          <ModalDescription>{t('linkBody')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <MemberSelect
            accountId={accountId}
            enabled={device !== null}
            value={userId}
            onChange={setPicked}
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={link.isPending || !device || userId === device.user_id}
            aria-busy={link.isPending}
            onClick={() =>
              device &&
              link.mutate(
                { deviceId: device.device_id, userId },
                {
                  onSuccess: () => {
                    successToast(userId ? t('linked') : t('unlinked'));
                    close();
                  },
                  onError: (error) => errorToast(errorText(error, t('linkFailed'))),
                },
              )
            }
          >
            {link.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
