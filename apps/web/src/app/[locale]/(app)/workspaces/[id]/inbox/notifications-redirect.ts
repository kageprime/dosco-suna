/**
 * The routing decision of /workspaces/[id]/inbox (KRTX-4799): the page holds
 * only the workspace's Review queue. A bookmark taken while Notifications was
 * still its second tab (`?view=notifications`) moves to the person's Inbox
 * page — notifications span every workspace, so they are not a view of a
 * workspace page. Every other address stays here.
 */
export function notificationsRedirectTarget(view: string | null | undefined): string | null {
  return view === 'notifications' ? '/inbox' : null;
}
