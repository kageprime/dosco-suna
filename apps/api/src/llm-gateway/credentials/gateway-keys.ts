/**
 * The one reader of LLM provider credentials for requests without a session
 * key selection: which key names a principal reaches, and the values of one
 * key name.
 *
 * The named store (`account_secret_resources`, the Models panel) serves
 * first. The legacy store (`project_secrets` with consumer `llm_gateway`) is
 * read only for rows the backfill has not moved yet: the gate is in
 * `projects/secrets/consumer-resolution.ts` (`legacySecretNotMoved`). After the
 * backfill has run in an environment the legacy branch returns nothing there,
 * except the rows the backfill skipped (`kortix.llm_credential_backfill`
 * outcome `skipped_*`). The follow-up that deletes the legacy rows deletes
 * the two `legacy*` calls below and nothing else.
 *
 * Every reader of provider key names or values goes through this module:
 * the gateway (`resolve-candidates.ts`), the picker (`servable-catalog.ts`),
 * routing (`routing/index.ts`), default models (`default-model.ts`, through
 * `defaultableGatewayKeyNames`) and the custom providers route. It always reads the named store: every
 * writer writes there now, so a reader that skipped it would lose keys.
 */
import {
  listGrantedGatewaySecretNames,
  listUsableGatewaySecrets,
  resolveProjectSharedProviderSecrets,
} from '../../secrets/account-resource';
// The module the gateway's key readers imported before this one existed: the
// projects surface pulls the route graph into every gateway test (a moved
// suppression, see eslint-suppressions.json).
import { listProjectSecretNamesForConsumer, resolveProjectSecretsForConsumer } from '../../projects/secrets';

/** Whose keys a read counts. */
export interface GatewayKeyScope {
  accountId: string;
  projectId: string;
  /**
   * The member whose project access admits keys shared with the whole
   * project. Absent: no named key is reachable (no member acts).
   */
  userId: string | null | undefined;
  /**
   * Whose member grants count in the named store. `null`: only keys shared
   * with the whole project (a shared session, a gateway API key).
   */
  grantUserId: string | null;
  /** Whose legacy personal override counts. Absent = `grantUserId`. */
  legacyPersonalUserId?: string | null;
}

/** Every key name `scope` reaches, from both stores. Never reads a value; a failed read counts as none. */
export async function connectedGatewayKeyNames(scope: GatewayKeyScope): Promise<Set<string>> {
  const [named, legacy] = await Promise.all([
    scope.userId
      ? listGrantedGatewaySecretNames(scope.accountId, scope.projectId, scope.userId, scope.grantUserId).catch(() => [] as string[])
      : [],
    listProjectSecretNamesForConsumer({
      projectId: scope.projectId,
      principalUserId: scope.legacyPersonalUserId === undefined ? scope.grantUserId : scope.legacyPersonalUserId,
      consumer: 'llm_gateway',
    }).catch(() => [] as string[]),
  ]);
  return new Set([...named, ...legacy]);
}

/**
 * The key names a default model may come from: every name `scope` reaches,
 * except a name whose every named key the provider refused at its last check
 * (`verify_status = 'invalid'`) and that has no legacy value. A key never
 * checked or checked `unknown` counts. The gateway's request-time candidates
 * do not use this: a model named explicitly still reaches the provider, and
 * the provider's refusal reaches the caller.
 */
export async function defaultableGatewayKeyNames(scope: GatewayKeyScope): Promise<Set<string>> {
  const [named, legacy] = await Promise.all([
    scope.userId
      ? listUsableGatewaySecrets({
          accountId: scope.accountId, projectId: scope.projectId, userId: scope.userId, grantUserId: scope.grantUserId,
        }).catch(() => [])
      : [],
    listProjectSecretNamesForConsumer({
      projectId: scope.projectId,
      principalUserId: scope.legacyPersonalUserId === undefined ? scope.grantUserId : scope.legacyPersonalUserId,
      consumer: 'llm_gateway',
    }).catch(() => [] as string[]),
  ]);
  return new Set([...named.filter((key) => key.verifyStatus !== 'invalid').map((key) => key.name), ...legacy]);
}

export interface GatewayKeyValue {
  /** What a log line and a 429 cooldown name: the named account id, or the legacy identifier. */
  identifier: string;
  secretId: string;
  value: string;
}

export interface GatewayKeyValues {
  keys: GatewayKeyValue[];
  /** `named`: the keys are named accounts (a 429 cools the account down); `legacy`: project secrets. */
  store: 'named' | 'legacy' | 'none';
  /** Every usable named key is cooling down after a rate limit. */
  coolingDown: boolean;
  retryAfterSeconds?: number;
  /** Named keys of the provider in the project this scope may not use (private to other members). */
  withheld: number;
}

/**
 * The values of one provider key name for `scope`: the named keys it may use,
 * oldest first and routed per session; else the legacy values not moved yet.
 * A named key this API cannot decrypt is skipped.
 */
export async function resolveGatewayKeyValues(scope: GatewayKeyScope & {
  providerId: string;
  name: string;
  sessionId?: string | null;
  /** A probe (a turn gate, the picker, a region read) never moves the session's account pin. */
  probe?: boolean;
}): Promise<GatewayKeyValues> {
  const shared = scope.userId
    ? await resolveProjectSharedProviderSecrets({
        accountId: scope.accountId, projectId: scope.projectId, userId: scope.userId,
        grantUserId: scope.grantUserId, providerId: scope.providerId, name: scope.name,
        sessionId: scope.sessionId, probe: scope.probe,
      })
    : null;
  const named = (shared?.secrets ?? []).flatMap((secret) =>
    secret.value === null ? [] : [{ identifier: secret.secretId, secretId: secret.secretId, value: secret.value }]);
  const withheld = shared?.withheld ?? 0;
  if (named.length) return { keys: named, store: 'named', coolingDown: false, withheld };
  const legacy = await resolveProjectSecretsForConsumer({
    projectId: scope.projectId, accountId: scope.accountId,
    sessionId: scope.sessionId, actorUserId: scope.userId ?? null,
    principalUserId: scope.legacyPersonalUserId === undefined ? scope.grantUserId : scope.legacyPersonalUserId,
    name: scope.name, consumer: 'llm_gateway', probe: scope.probe,
  });
  if (legacy.length) {
    return {
      keys: legacy.map((row) => ({ identifier: row.identifier, secretId: row.secretId, value: row.value })),
      store: 'legacy', coolingDown: false, withheld,
    };
  }
  return {
    keys: [], store: 'none', coolingDown: shared?.coolingDown ?? false,
    ...(shared?.retryAfterSeconds !== undefined ? { retryAfterSeconds: shared.retryAfterSeconds } : {}),
    withheld,
  };
}

/** The first value of a key name, or null. A probe read: for a setting (Bedrock's region) or a catalog listing. */
export async function firstGatewayKeyValue(scope: GatewayKeyScope & { providerId: string; name: string; sessionId?: string | null }): Promise<string | null> {
  return (await resolveGatewayKeyValues({ ...scope, probe: true })).keys[0]?.value ?? null;
}
