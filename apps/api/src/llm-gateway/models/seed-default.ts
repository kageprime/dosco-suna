import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import {
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from '../../repositories/model-preferences';
import {
  invalidateAccountModelDefaults,
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../resolution/default-model';
import { toWireModel } from '../resolution/effective';
import { flagshipRefForEnvVar } from './picker-catalog';
import { platformDefaultModelId } from './served-managed-models';

// Seed a PROJECT default model when a provider key is saved, but only for a
// workspace that has NO usable default at all. Both key writers call this:
// the Models panel (`secret-resources.ts`) and the legacy `/secrets` route.
// Runs detached; never throws into the request.
//
// It seeds only when all of these are true:
//   1. no account or project default is configured (never clobbers one);
//   2. the platform default does not serve: the account may not use
//      Kortix-managed models, or this deployment serves none. A paid Credits workspace once got
//      `openrouter/…-preview:free` here and its first chat failed;
//   3. no model of the workspace's own (a ChatGPT login, another provider
//      key, a Claude account) already serves a shared session;
//   4. the provider's flagship serves EVERY session of the workspace: a key
//      only its owner may use is not a workspace default;
//   5. the key passed its provider check (`keyCheck`, `provider-verify.ts`)
//      wherever the writer runs one: a refused or unchecked key never becomes
//      the default (a fake Groq key once failed every new session with 401).
// Idempotent: a concurrent save never overwrites (onlyIfAbsent).

export async function seedProjectDefaultModelOnConnect(params: {
  projectId: string;
  accountId: string;
  userId: string;
  secretName: string;
  /** The saved key's provider check; omitted where the writer runs none. */
  keyCheck?: 'verified' | 'invalid' | 'unknown';
}): Promise<void> {
  try {
    if (params.keyCheck !== undefined && params.keyCheck !== 'verified') return;
    const flagshipRef = flagshipRefForEnvVar(params.secretName);
    if (!flagshipRef) return; // not a known provider credential (e.g. codex auth)

    const defaults = await getAccountModelDefaults(params.accountId, params.projectId);
    if (defaults.account || defaults.projects[params.projectId]) return; // already chosen

    const shared = {
      userId: params.userId,
      accountId: params.accountId,
      projectId: params.projectId,
      freeModelsOnly: true,
      personalUserId: null, // a shared session: keys shared with the whole workspace only
    };
    // The platform default serves every session of an account with managed models.
    if (
      (await accountMayUseManagedModels(params.accountId)) &&
      (await isModelServableForAccount({ ...shared, freeModelsOnly: false, model: platformDefaultModelId() }))
    ) {
      return;
    }

    const flagshipProvider = flagshipRef.slice(0, flagshipRef.indexOf('/'));
    const current = await resolveEffectiveModel(shared);
    if (current.model && !toWireModel(current.model).startsWith(`${flagshipProvider}/`)) return;

    if (!(await isModelServableForAccount({ ...shared, model: flagshipRef }))) return;

    await upsertAccountModelPreference({
      accountId: params.accountId,
      scope: 'project',
      scopeKey: params.projectId,
      model: toWireModel(flagshipRef),
      onlyIfAbsent: true,
    });
    invalidateAccountModelDefaults(params.accountId);
  } catch (err) {
    console.warn(
      `[seed-default] failed to seed project default for ${params.projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
