/**
 * May a trigger fire start a session? A fire runs with no person (spec
 * 2026-09-22 §2.3), so its session reaches only keys and accounts shared with
 * the whole workspace: the gateway's models (keys, ChatGPT accounts, managed
 * models) and a Claude subscription account. A fire that cannot reach one
 * mints a session that dies on its first turn.
 *
 * The check before 2026-11-11 counted the actor's private keys and never a
 * Claude account, so a workspace that runs on a Claude subscription was always
 * refused, and a workspace whose only key was private was let through to fail.
 */
import { countUsableClaudeAccounts, hasClaudeCredential } from '../../claude-subscription/accounts';
import { servableProjectCatalog } from '../../llm-gateway/models/servable-catalog';

export const NO_USABLE_MODEL =
  'No usable model for this account. Connect a provider key or upgrade the plan, then fire again.';

export const ONLY_PRIVATE_MODELS =
  'Automations run without a person, so they use only model keys and accounts shared with everyone in the workspace. ' +
  'Yours are private: share one with everyone in Models, or add a workspace key, then fire again.';

const anyEnabled = (catalog: Awaited<ReturnType<typeof servableProjectCatalog>>) =>
  Object.values(catalog.models).some((model) => model.enabled);

/** Null when the fire has a model to run on; else the refusal the trigger shows. */
export async function triggerModelRefusal(input: {
  accountId: string;
  projectId: string;
  /** The member the run executes as (the automation actor). */
  actor: string;
}): Promise<string | null> {
  const { accountId, projectId, actor } = input;
  const shared = await servableProjectCatalog({ projectId, accountId, principalUserId: actor, personalUserId: null });
  if (anyEnabled(shared)) return null;
  if (await hasClaudeCredential({ accountId, projectId, userId: actor, sessionId: null, personalUserId: null })) return null;
  const [own, ownClaude] = await Promise.all([
    servableProjectCatalog({ projectId, accountId, principalUserId: actor }),
    countUsableClaudeAccounts(accountId, projectId, actor).catch(() => 0),
  ]);
  return anyEnabled(own) || ownClaude > 0 ? ONLY_PRIVATE_MODELS : NO_USABLE_MODEL;
}
