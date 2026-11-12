'use client';

/**
 * The account member list, read once and shared by the hub page (the Members
 * pane) and the settings sidebar (the count beside "Members"). One key, one
 * fetcher, one gate — two hand-typed copies is how a "13 readers, one
 * request" property quietly becomes two requests (see
 * `packages/ui/src/internal/hooks/account/use-accounts-list.ts` for the longer version of that story).
 */

import type { AccountRole } from '@kortix/sdk';
import { listAccountMembers } from '@kortix/sdk';
import { contract } from '@kortix/sdk/react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useUiViewerId } from '../../providers/ui-provider';

/** Account-level standing of one member, keyed by user id. */
export interface AccountMemberMeta {
  email: string | null;
  accountRole: AccountRole;
  isSuperAdmin: boolean;
}

export function useAccountMembers(
  accountId: string | undefined,
  /** Extra gate ANDed with the signed-in check — a surface that only needs
   *  the roster while a dialog is open passes `{ enabled: isOpen }`. */
  options?: { enabled?: boolean },
): UseQueryResult<Awaited<ReturnType<typeof listAccountMembers>>, Error> & {
  /** user_id → email. Members without an email are absent: the caller
   *  renders the raw user id (the fallback the IAM tables show). */
  emailByUserId: Map<string, string>;
  /** user_id → account-level standing (email, role, super-admin flag). */
  accountMetaByUserId: Map<string, AccountMemberMeta>;
} {
  const viewerId = useUiViewerId();
  // `GET .../members` answers every account member: the whole directory with
  // `member.read`, else only the caller. No probe to
  // wait for.
  const query = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!viewerId && !!accountId && (options?.enabled ?? true),
    ...contract('directory'),
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of query.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [query.data]);

  const accountMetaByUserId = useMemo(() => {
    const map = new Map<string, AccountMemberMeta>();
    for (const m of query.data ?? []) {
      map.set(m.user_id, {
        email: m.email,
        accountRole: m.account_role,
        isSuperAdmin: !!m.is_super_admin,
      });
    }
    return map;
  }, [query.data]);

  return { ...query, emailByUserId, accountMetaByUserId };
}
