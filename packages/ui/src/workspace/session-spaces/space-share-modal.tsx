'use client';

import { ApiError, type ProjectSessionGroup } from '@kortix/sdk';
import { useSetWorkspaceSessionGroupSharing } from '@kortix/sdk/react';
import { LockSimpleIcon, TrashIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import {
  SHARE_GROUP,
  ShareAddField,
  ShareGeneralAccess,
  ShareLinkField,
  ShareRole,
  ShareRoleMenu,
  ShareRow,
  ShareSection,
  type ShareCandidate,
} from '../../access/share-dialog';
import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '../../primitives/modal';
import { errorToast, successToast } from '../../primitives/toast';
import { spacePeople, useWorkspacePeople, type WorkspacePerson } from './space-people';

type Sharing = { visibility: 'private' | 'project'; member_ids: string[] };

function sharingOf(space: ProjectSessionGroup): Sharing {
  return { visibility: space.visibility === 'project' ? 'project' : 'private', member_ids: [...(space.member_ids ?? [])] };
}

function candidateOf(id: string, person: WorkspacePerson | undefined): ShareCandidate {
  return {
    id,
    kind: 'member',
    label: person?.name ?? person?.email ?? id,
    sublabel: person?.name ? person.email : null,
    email: person?.email ?? null,
    avatarUrl: person?.avatarUrl ?? null,
  };
}

/**
 * Share a space. Every change saves at once; there is no Save button.
 * Add people, the people with access (the creator is Owner, the rest can be
 * removed after a confirm), general access (only the people added, or the
 * whole workspace: "everyone" clears the list) and the space's link.
 * Whoever it is shared with sees every session in it and its Files folder.
 */
export function SpaceShareModal({
  projectId,
  space,
  open,
  onOpenChange,
}: {
  projectId: string;
  space: ProjectSessionGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('sessionSpaces');
  const share = useSetWorkspaceSessionGroupSharing(projectId);
  const people = useWorkspacePeople(projectId, open);
  // Rows read the space's own people first: they carry profiles even before the workspace list loads.
  const own = spacePeople(space);
  const personOf = (id: string) => own.get(id) ?? people.get(id);
  const [removing, setRemoving] = useState<string | null>(null);

  // The pending write is what the dialog shows, so a change never flickers back.
  const sharing: Sharing =
    share.isPending && share.variables?.groupId === space.group_id
      ? { visibility: share.variables.input.visibility, member_ids: share.variables.input.member_ids ?? [] }
      : sharingOf(space);
  const everyone = sharing.visibility === 'project';
  const creator = space.created_by;

  const save = async (next: Sharing) => {
    try {
      await share.mutateAsync({
        groupId: space.group_id,
        input: next.visibility === 'project' ? { visibility: 'project' } : { visibility: 'private', member_ids: next.member_ids },
      });
      successToast(t('shared'));
      return true;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      errorToast(code === 'not_a_member' ? t('shareNotMember') : t('shareFailed'));
      return false;
    }
  };

  const candidates = useMemo(() => [...people].map(([id, person]) => candidateOf(id, person)), [people]);
  const excludeIds = useMemo(
    () => new Set([creator, ...sharing.member_ids].filter((id): id is string => !!id)),
    [creator, sharing.member_ids],
  );

  const href = uiRoutes().sessionSpace?.(projectId, space.group_id);
  const link = href && typeof window !== 'undefined' ? `${window.location.origin}${href}` : null;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      successToast(t('linkCopied'));
    } catch {
      errorToast(t('linkCopyFailed'));
    }
  };

  const removingPerson = removing ? personOf(removing) : undefined;

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>{t('shareTitle', { name: space.name })}</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-5">
            <ShareAddField
              candidates={candidates}
              excludeIds={excludeIds}
              onShare={(picked) => save({ visibility: 'private', member_ids: [...sharing.member_ids, ...picked.map((candidate) => candidate.id)] })}
              pending={share.isPending}
              disabled={everyone}
              placeholder={everyone ? t('shareEveryoneHint') : t('shareAddPlaceholder')}
              shareLabel={t('share')}
              removeLabel={t('shareRemove')}
              onUnknownEmails={() => errorToast(t('shareNotMember'))}
            />

            <ShareSection label={t('sharePeopleWithAccess')}>
              <ul className={SHARE_GROUP}>
                {creator ? <ShareRow candidate={candidateOf(creator, personOf(creator))} trailing={<ShareRole>{t('shareOwner')}</ShareRole>} /> : null}
                {everyone
                  ? null
                  : sharing.member_ids.map((id) => (
                      <ShareRow
                        key={id}
                        candidate={candidateOf(id, personOf(id))}
                        trailing={
                          <ShareRoleMenu
                            label={t('roleMember')}
                            removeLabel={t('shareRemove')}
                            removeIcon={<TrashIcon />}
                            onRemove={() => setRemoving(id)}
                            disabled={share.isPending}
                          />
                        }
                      />
                    ))}
              </ul>
            </ShareSection>

            <ShareSection label={t('shareGeneralAccess')}>
              <ShareGeneralAccess
                value={sharing.visibility}
                changeLabel={t('shareChange')}
                disabled={share.isPending}
                onChange={(next) => void save({ visibility: next, member_ids: [] })}
                options={[
                  { value: 'private', label: t('shareRestricted'), hint: t('shareRestrictedHint'), icon: <LockSimpleIcon /> },
                  { value: 'project', label: t('shareEveryone'), hint: t('shareEveryoneHint'), icon: <UsersThreeIcon /> },
                ]}
              />
            </ShareSection>

            {link ? <ShareLinkField link={link} copyLabel={t('copyLink')} onCopy={() => void copy()} /> : null}
          </ModalBody>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title={t('shareRemoveTitle')}
        description={t('shareRemoveDescription', { name: removingPerson?.name ?? removingPerson?.email ?? '' })}
        confirmLabel={t('shareRemove')}
        confirmVariant="destructive"
        isPending={share.isPending}
        onConfirm={() => {
          const id = removing;
          if (!id) return;
          void save({ visibility: 'private', member_ids: sharing.member_ids.filter((other) => other !== id) }).then(() => setRemoving(null));
        }}
      />
    </>
  );
}
