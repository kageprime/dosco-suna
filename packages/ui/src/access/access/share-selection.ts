// The Share dialog's one selection rule. The picker shows every principal that
// has access to the account as checked: unchecking it marks its grant for
// removal, checking it again keeps the grant, and anything else checked is an
// addition. The audience rows' Remove/Keep buttons edit the same `removed`
// set, so the two controls never disagree.
//
// Before: a principal with access was an ordinary unchecked picker row.
// Clicking it picked it again, and the save plan cancels a removal whose
// principal is picked (`planConnectionShare`), so "Remove" then did nothing
// and Save stayed disabled until the picker was cleared.

import type { ConnectionShare } from '@kortix/sdk';

import type { PrincipalSelection } from './principal-picker';

type Key = 'memberIds' | 'groupIds' | 'agentIds';

const KEY_OF: Record<Exclude<ConnectionShare['principal_type'], 'project'>, Key> = {
  member: 'memberIds',
  group: 'groupIds',
  agent: 'agentIds',
};

function selected(selection: PrincipalSelection, grant: ConnectionShare): boolean {
  if (grant.principal_type === 'project') return selection.everyone === true;
  return (selection[KEY_OF[grant.principal_type]] ?? []).includes(grant.principal_id);
}

/** What the picker shows: the new picks plus every grant not marked removed. */
export function shareSelectionView(
  current: readonly ConnectionShare[],
  removed: ReadonlySet<string>,
  picked: PrincipalSelection,
): PrincipalSelection {
  const view: PrincipalSelection = {
    ...picked,
    memberIds: [...picked.memberIds],
    groupIds: [...picked.groupIds],
    agentIds: [...(picked.agentIds ?? [])],
  };
  for (const grant of current) {
    if (removed.has(grant.grant_id) || selected(view, grant)) continue;
    if (grant.principal_type === 'project') view.everyone = true;
    else view[KEY_OF[grant.principal_type]]!.push(grant.principal_id);
  }
  return view;
}

/** Split the picker's next value into new picks and grants marked removed. */
export function applyShareSelection(
  current: readonly ConnectionShare[],
  removed: ReadonlySet<string>,
  next: PrincipalSelection,
): { picked: PrincipalSelection; removed: Set<string> } {
  const nextRemoved = new Set(removed);
  const picked: PrincipalSelection = {
    ...next,
    memberIds: [...next.memberIds],
    groupIds: [...next.groupIds],
    agentIds: [...(next.agentIds ?? [])],
  };
  for (const grant of current) {
    if (selected(next, grant)) {
      // Checked: the grant stays. It is not an addition.
      nextRemoved.delete(grant.grant_id);
      if (grant.principal_type === 'project') picked.everyone = false;
      else {
        const key = KEY_OF[grant.principal_type];
        picked[key] = (picked[key] ?? []).filter((id) => id !== grant.principal_id);
      }
    } else {
      nextRemoved.add(grant.grant_id);
    }
  }
  return { picked, removed: nextRemoved };
}
