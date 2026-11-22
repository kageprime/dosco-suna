'use client';

import { listGroups, type ProjectSession } from '@kortix/sdk';
import { TrashIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  SHARE_GROUP,
  ShareAddField,
  ShareRole,
  ShareRoleMenu,
  ShareRow,
  ShareSection,
  type ShareCandidate,
} from '../../../access/share-dialog';
import type { SharingSelection } from '../../../access/sharing-intent';
import { useTranslations } from '../../../i18n';
import { errorToast } from '../../../primitives/toast';
import { useUiHostConfig } from '../../../providers/ui-provider';
import { useWorkspacePeople } from '../../session-spaces/space-people';

/**
 * "Specific people" in the session access dialog: add people and groups
 * (several at once) and the people with access, owner first. It edits the
 * dialog's selection only; the dialog's Save writes it.
 */
export function SessionPeoplePicker({
  projectId,
  session,
  value,
  onChange,
}: {
  projectId: string;
  session: ProjectSession | null;
  value: SharingSelection;
  onChange: (next: SharingSelection) => void;
}) {
  const t = useTranslations('sessionShare');
  const { accountApiEnabled } = useUiHostConfig();
  const people = useWorkspacePeople(projectId, true);
  const accountId = session?.account_id ?? null;
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId!),
    enabled: !!accountId && accountApiEnabled,
    staleTime: 60_000,
  });

  const groupSublabel = (count: number | undefined) => (count === undefined ? null : t('groupMembers', { count }));
  const candidates = useMemo<ShareCandidate[]>(
    () => [
      ...[...people].map(([id, person]) => ({
        id,
        kind: 'member' as const,
        label: person.name || person.email || id,
        sublabel: person.name && person.email ? person.email : null,
        email: person.email || null,
        avatarUrl: person.avatarUrl,
      })),
      ...(groupsQuery.data ?? []).map((group) => ({
        id: group.group_id,
        kind: 'group' as const,
        label: group.name,
        sublabel: group.member_count === undefined ? null : t('groupMembers', { count: group.member_count }),
      })),
    ],
    [people, groupsQuery.data, t],
  );
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.id, candidate])), [candidates]);

  const ownerId = session?.created_by ?? null;
  const excludeIds = useMemo(
    () => new Set([ownerId, ...value.memberIds, ...value.groupIds].filter((id): id is string => !!id)),
    [ownerId, value.memberIds, value.groupIds],
  );
  const owner: ShareCandidate = {
    id: ownerId ?? 'owner',
    kind: 'member',
    label: session?.owner_name || session?.owner_email || t('owner'),
    sublabel: session?.owner_name ? session.owner_email : null,
    email: session?.owner_email ?? null,
    avatarUrl: session?.owner_avatar_url ?? null,
  };
  const added: ShareCandidate[] = [
    ...value.memberIds.map((id) => byId.get(id) ?? { id, kind: 'member' as const, label: t('member') }),
    ...value.groupIds.map((id) => byId.get(id) ?? { id, kind: 'group' as const, label: t('group'), sublabel: groupSublabel(undefined) }),
  ];

  return (
    <div className="space-y-5">
      <ShareAddField
        candidates={candidates}
        excludeIds={excludeIds}
        onShare={(picked) => {
          onChange({
            ...value,
            memberIds: [...value.memberIds, ...picked.filter((c) => c.kind === 'member').map((c) => c.id)],
            groupIds: [...value.groupIds, ...picked.filter((c) => c.kind === 'group').map((c) => c.id)],
          });
          return Promise.resolve(true);
        }}
        pending={false}
        disabled={false}
        placeholder={t('addPlaceholder')}
        shareLabel={t('share')}
        removeLabel={t('remove')}
        onUnknownEmails={() => errorToast(t('notMember'))}
      />
      <ShareSection label={t('peopleWithAccess')}>
        <ul className={SHARE_GROUP}>
          <ShareRow candidate={owner} trailing={<ShareRole>{t('owner')}</ShareRole>} />
          {added.map((candidate) => (
            <ShareRow
              key={candidate.id}
              candidate={candidate}
              trailing={
                <ShareRoleMenu
                  label={candidate.kind === 'group' ? t('group') : t('member')}
                  removeLabel={t('remove')}
                  removeIcon={<TrashIcon />}
                  onRemove={() =>
                    onChange({
                      ...value,
                      memberIds: value.memberIds.filter((id) => id !== candidate.id),
                      groupIds: value.groupIds.filter((id) => id !== candidate.id),
                    })
                  }
                />
              }
            />
          ))}
        </ul>
      </ShareSection>
    </div>
  );
}
