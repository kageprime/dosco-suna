/** Reasons that close a workspace, never the person's login. */
export const WORKSPACE_CLOSE_REASON = 'workspace_deleted';
export const WORKSPACE_CLOSE_REASON_SUBSCRIPTION = 'workspace_deleted:subscription_cancelled';

export function isWorkspaceDeletion(reason: string | null | undefined): boolean {
  return reason === WORKSPACE_CLOSE_REASON || reason === WORKSPACE_CLOSE_REASON_SUBSCRIPTION;
}
