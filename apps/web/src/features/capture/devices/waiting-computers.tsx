'use client';

import type { CaptureEnrollment } from '@kortix/sdk';
import {
  useApproveCaptureEnrollment,
  useCaptureEnrollments,
  useDenyCaptureEnrollment,
} from '@kortix/sdk/react';
import { DesktopIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { CountBadge } from '@kortix/ui/count-badge';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@kortix/ui/table';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';

import { errorText, personLabel } from './rollout-model';
import { MemberSelect } from './member-select';

// ─── Waiting computers ───────────────────────────────────────────────────────

/**
 * Computers that presented an enrollment token and wait for a decision: their
 * person is no member yet, or the token approves each computer. Shown above
 * the device list while any waits.
 */
export function WaitingComputers({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.rollout');
  const waiting = useCaptureEnrollments(accountId, { status: 'pending' });
  const rows = waiting.data?.enrollments ?? [];
  const [approving, setApproving] = useState<CaptureEnrollment | null>(null);
  if (rows.length === 0) return null;
  return (
    <section aria-label={t('waitingTitle')} className="space-y-3">
      <div className="flex items-center gap-2">
        <Label>{t('waitingTitle')}</Label>
        <CountBadge count={rows.length} tone="waiting" />
      </div>
      <p className="text-muted-foreground text-xs text-pretty">{t('waitingBody')}</p>
      <Table className="min-w-3xl">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">{t('col.person')}</TableHead>
            <TableHead>{t('col.computer')}</TableHead>
            <TableHead>{t('col.reason')}</TableHead>
            <TableHead>{t('col.lastSeen')}</TableHead>
            <TableHead className="pr-4">
              <span className="sr-only">{t('col.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <WaitingRow
              key={row.enrollment_id}
              accountId={accountId}
              row={row}
              onApprove={() => setApproving(row)}
            />
          ))}
        </TableBody>
      </Table>
      <ApproveModal accountId={accountId} row={approving} onClose={() => setApproving(null)} />
    </section>
  );
}

function WaitingRow({
  accountId,
  row,
  onApprove,
}: {
  accountId: string;
  row: CaptureEnrollment;
  onApprove: () => void;
}) {
  const t = useTranslations('capture.rollout');
  const locale = useLocale();
  const deny = useDenyCaptureEnrollment(accountId);
  const [confirm, setConfirm] = useState(false);
  const person = personLabel(row);
  return (
    <TableRow>
      <TableCell className="pl-4">
        <span className="text-foreground block truncate font-medium">{person}</span>
        {row.principal_name && row.account_name ? (
          <span className="text-muted-foreground block truncate text-xs">{row.account_name}</span>
        ) : null}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          <DesktopIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{row.device.name ?? t('unnamed')}</span>
        </span>
        <span className="text-muted-foreground block text-xs">{row.token_name}</span>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-72 min-w-56 text-xs text-pretty whitespace-normal">
        {t('reason.approval_required')}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {relativeTime(Date.parse(row.last_seen_at), locale)}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <span className="inline-flex items-center gap-1">
          <Button variant="outline-ghost" size="sm" onClick={() => setConfirm(true)}>
            {t('deny')}
          </Button>
          <Button size="sm" onClick={onApprove}>
            {t('approve')}
          </Button>
        </span>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={t('denyTitle', { person })}
          description={t('denyBody')}
          confirmLabel={t('deny')}
          confirmVariant="destructive"
          isPending={deny.isPending}
          onConfirm={() =>
            deny.mutate(row.enrollment_id, {
              onSuccess: () => {
                successToast(t('denied'));
                setConfirm(false);
              },
              onError: (error) => errorToast(errorText(error, t('decideFailed'))),
            })
          }
        />
      </TableCell>
    </TableRow>
  );
}

/** Approve a waiting computer, linked to a member or to no one. The matched member is preselected. */
function ApproveModal({
  accountId,
  row,
  onClose,
}: {
  accountId: string;
  row: CaptureEnrollment | null;
  onClose: () => void;
}) {
  const t = useTranslations('capture.rollout');
  const approve = useApproveCaptureEnrollment(accountId);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const userId = picked === undefined ? (row?.user_id ?? null) : picked;
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  return (
    <Modal open={row !== null} onOpenChange={(open) => (open ? null : close())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('approveTitle')}</ModalTitle>
          <ModalDescription>
            {row
              ? t('approveBody', {
                  person: personLabel(row),
                  computer: row.device.name ?? t('unnamed'),
                })
              : null}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <MemberSelect
            accountId={accountId}
            enabled={row !== null}
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
            disabled={approve.isPending}
            aria-busy={approve.isPending}
            onClick={() =>
              row &&
              approve.mutate(
                { enrollmentId: row.enrollment_id, userId },
                {
                  onSuccess: () => {
                    successToast(t('approved'));
                    close();
                  },
                  onError: (error) => errorToast(errorText(error, t('decideFailed'))),
                },
              )
            }
          >
            {approve.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('approve')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
