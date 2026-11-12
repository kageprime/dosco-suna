/**
 * What the engine needs to know about an account's workspace, read once per
 * account (design.md §3.2 C1, C3): its one live project, whether it is
 * split_pending, and whether it is closing. Its own module, so the route tests
 * that replace `iam/authorize` wholesale keep the real reader.
 */
import { isUuid } from '../shared/validate';
import { readAccountEngineFacts, resolveWorkspace } from '../workspaces/surface';
import { ttlMemo } from '../shared/ttl-memo';
import { invalidateIamCacheForProjectResources, registerProjectScopedMemo } from './cache-invalidation';

/** The IAM memo window (iam/authorize.ts reads the same 15 s default). */
const TTL_MS = 15_000;

/**
 * What the engine needs to know about an account's workspace, read once per
 * account:
 *   - `soleProjectId`: the account's one active project (= its workspace id)
 *     when it is not split_pending; null for a project-less (dormant) account,
 *     a closing one (its project row is archived) and a split_pending one;
 *   - `closing`: an account deletion request is open (lifecycle `closing`).
 *
 * Cached only while the account is not closing and either has its one
 * workspace or is split_pending (a dormant or closing account is read fresh,
 * so a provision or a restore is seen on the next request). The deleting,
 * restoring and splitting writers bust it through
 * `invalidateWorkspaceFactsForAccount`; the TTL is the cross-replica backstop.
 * Keyed `${accountId}|…` and registered as a project-scoped memo: the bust
 * reuses the project channel, which crosses replicas.
 */
export interface WorkspaceFacts {
  soleProjectId: string | null;
  splitPending: boolean;
  closing: boolean;
}

const NO_WORKSPACE: WorkspaceFacts = { soleProjectId: null, splitPending: false, closing: false };

const workspaceFactsMemo = ttlMemo({
  ttlMs: TTL_MS,
  keyFn: (accountId: string) => `${accountId}|workspace-facts`,
  loader: async (accountId: string): Promise<WorkspaceFacts> => {
    if (!isUuid(accountId)) return NO_WORKSPACE;
    const { activeProjects: active, deletionOpen } = await readAccountEngineFacts(accountId);
    const splitPending = active.length > 1 || active.some((row) => row.splitPending);
    return {
      soleProjectId: active.length === 1 && !splitPending ? active[0]!.projectId : null,
      splitPending,
      closing: deletionOpen,
    };
  },
  shouldCache: (facts) => !facts.closing && (facts.soleProjectId !== null || facts.splitPending),
});
registerProjectScopedMemo(workspaceFactsMemo);

/** The workspace facts of one account (memoized; see `WorkspaceFacts`). */
export function workspaceFactsOf(accountId: string): Promise<WorkspaceFacts> {
  if (!accountId) return Promise.resolve(NO_WORKSPACE);
  return workspaceFactsMemo(accountId);
}

/** A workspace was closed, restored, split or set up: drop its cached facts on every replica. */
export function invalidateWorkspaceFactsForAccount(accountId: string): void {
  invalidateIamCacheForProjectResources(accountId);
}

/** Test hook. */
export function clearWorkspaceFacts(): void {
  workspaceFactsMemo.clear();
}

/**
 * True when `workspaceId` (a bound token's workspace) is a workspace of the
 * split_pending account `accountId`: the token's own account holds other
 * workspaces too. Read only on a denial path, to pick the refusal reason.
 * A lookup error answers false (the generic `token_out_of_scope` stays).
 */
export async function tokenWorkspaceSharesAccount(workspaceId: string, accountId: string): Promise<boolean> {
  try {
    const resolved = await resolveWorkspace(workspaceId);
    return resolved !== null && resolved.splitPending && resolved.accountId === accountId;
  } catch {
    return false;
  }
}
