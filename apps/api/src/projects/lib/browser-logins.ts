/**
 * Website logins: a username and password that the sandbox browser types into
 * a sign-in page while the agent sees only the login's NAME.
 *
 * A login is ONE project secret row, so it inherits encryption, audience
 * ("only the person who asked"), agent grants, audit and deletion:
 *
 *   value            JSON `{ username, password }`, encrypted per project
 *   strategy         `broker`: never plaintext in the sandbox env
 *   consumer         `browser`: only `resolveBrowserLogin` spends it
 *   egress_policy    `{ rules: [{ host }] }`: the sites it may be typed on
 *   strategy_locked  no write path can turn it into an env var
 *
 * In the sandbox, `kortix secrets browser-plugin` is an agent-browser
 * credential plugin: `agent-browser auth login … --credential-provider kortix
 * --item NAME` asks it for the login, it calls the resolve route with the
 * session's own token, and agent-browser types the value into the page. The
 * value passes through the sandbox for that moment; it is never printed, never
 * in the env, and never in the transcript.
 */
import { randomUUID } from 'node:crypto';
import { projectSecrets, projectSessions } from '@kortix/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { encryptProjectSecret } from '../secrets/envelope';
import { resolveProjectSecretForConsumer } from '../secrets/consumer-resolution';
import { isValidSecretName } from '../secrets/grant-policy';
import { filterSecretRowsByAudience, secretAudienceSubject, setSecretAudience } from './secret-audience';
import {
  resolveSessionSecretReach,
  type SessionWithheldSecrets,
  withheldSecrets,
  withheldSecretsFix,
} from './session-secret-reach';
import {
  type BrowserLoginValue,
  decodeBrowserLogin,
  encodeBrowserLogin,
  loginPolicyFor,
  loginSiteAdmits,
  loginSitesOf,
  loginUrlHost,
  normalizeLoginSites,
  parseBrowserLoginInput,
} from './browser-login-sites';

export * from './browser-login-sites';

/**
 * Write (or replace) the SHARED login row `name`. The caller has already
 * refused a name held by a secret that is not a login: the update half only
 * ever touches a `browser` row, so it can never turn an API key into a login.
 * Returns the row id, or null when `name` belongs to a secret that is not a
 * login (the conflict update matched nothing).
 */
export async function writeBrowserLogin(input: {
  projectId: string;
  name: string;
  login: BrowserLoginValue;
  sites: readonly string[];
  createdBy: string | null;
  /** Id for a NEW row; its audience may already be written under it. */
  secretId?: string;
}): Promise<string | null> {
  const now = new Date();
  const valueEnc = encryptProjectSecret(input.projectId, encodeBrowserLogin(input.login));
  const egressPolicy = loginPolicyFor(input.sites);
  const [row] = await db
    .insert(projectSecrets)
    .values({
      ...(input.secretId ? { secretId: input.secretId } : {}),
      projectId: input.projectId,
      identifier: input.name,
      name: input.name,
      valueEnc,
      scope: 'runtime',
      strategy: 'broker',
      consumer: 'browser',
      egressPolicy,
      strategyLocked: true,
      description: `Website login for ${input.sites.join(', ')}`,
      createdBy: input.createdBy,
      rotatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.projectId, projectSecrets.identifier],
      targetWhere: isNull(projectSecrets.ownerUserId),
      set: {
        valueEnc,
        egressPolicy,
        description: `Website login for ${input.sites.join(', ')}`,
        rotatedAt: now,
        updatedAt: now,
      },
      setWhere: eq(projectSecrets.consumer, 'browser'),
    })
    .returning({ secretId: projectSecrets.secretId });
  return row?.secretId ?? null;
}

/** The shared row that holds identifier `name`, with what a login check needs. */
export async function sharedSecretRow(
  projectId: string,
  name: string,
): Promise<{ secretId: string; consumer: string | null } | null> {
  const [row] = await db
    .select({ secretId: projectSecrets.secretId, consumer: projectSecrets.consumer })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.identifier, name),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Does the existing login's audience equal the one a new submission asks for?
 * `requesterId` null = everyone in the project. A link may replace a login's
 * value only when it keeps the same people: otherwise one person's password
 * would reach another person's sessions, or a private login would turn shared.
 */
export async function browserLoginAudienceIs(
  projectId: string,
  secretId: string,
  requesterId: string | null,
): Promise<boolean> {
  const { loadObjectGrants } = await import('../../iam/authorize');
  const grants = (await loadObjectGrants(projectId, 'secret')).get(secretId) ?? [];
  const open = grants.length === 0 || grants.some((grant) => grant.principalType === 'project');
  if (requesterId === null) return open;
  if (open) return false;
  return grants.every(
    (grant) =>
      (grant.principalType === 'user' || grant.principalType === 'member') &&
      grant.principalId === requesterId,
  );
}

interface LoginRow {
  secretId: string;
  identifier: string;
  name: string;
  consumer: string | null;
  egressPolicy: unknown;
  active: boolean;
}

async function sharedRowsNamed(projectId: string, name: string): Promise<LoginRow[]> {
  return db
    .select({
      secretId: projectSecrets.secretId,
      identifier: projectSecrets.identifier,
      name: projectSecrets.name,
      consumer: projectSecrets.consumer,
      egressPolicy: projectSecrets.egressPolicy,
      active: projectSecrets.active,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        isNull(projectSecrets.ownerUserId),
      ),
    );
}

export interface BrowserLoginListing {
  name: string;
  sites: string[];
  /** False when this session's agent may not use it; `fix` says why. */
  available: boolean;
  fix?: string;
}

/**
 * The logins a caller can use, without values. In a session: the logins its
 * person may use (audience) and whether its agent's grant admits each one.
 * Without a session: the logins the calling person may use.
 */
export async function listBrowserLogins(input: {
  projectId: string;
  accountId: string;
  sessionId: string | null;
  actorUserId: string | null;
}): Promise<BrowserLoginListing[]> {
  const rows = await db
    .select({
      secretId: projectSecrets.secretId,
      name: projectSecrets.name,
      egressPolicy: projectSecrets.egressPolicy,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, input.projectId),
        eq(projectSecrets.consumer, 'browser'),
        isNull(projectSecrets.ownerUserId),
        eq(projectSecrets.active, true),
      ),
    );
  const reachable = await filterSecretRowsByAudience({
    projectId: input.projectId,
    accountId: input.accountId,
    subject: () =>
      secretAudienceSubject({
        projectId: input.projectId,
        accountId: input.accountId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
      }),
    rows,
  });
  let reach: Awaited<ReturnType<typeof resolveSessionSecretReach>> = null;
  if (input.sessionId) {
    try {
      reach = await resolveSessionSecretReach(input.sessionId);
    } catch {
      reach = null;
    }
  }
  return reachable
    .map((row) => {
      const withheld = reach ? withheldSecrets([row.name], reach.grantEnv, reach.allowlist) : [];
      return {
        name: row.name,
        sites: loginSitesOf(row.egressPolicy as Parameters<typeof loginSitesOf>[0]),
        available: withheld.length === 0,
        ...(reach && withheld.length > 0 ? { fix: withheldSecretsFix(reach.agent, withheld) } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type BrowserLoginResolution =
  | { ok: true; name: string; username: string; password: string; url: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; code: string; error: string };

const requestHint = (name: string, site = '<host>') =>
  `kortix secrets request ${name} --login --site ${site}`;

/**
 * Hand one login to the sandbox browser of `sessionId`, for `url`. Every check
 * runs before the value is decrypted:
 *
 *   1. the name is a login (not missing, not an ordinary secret);
 *   2. `url`'s host is one of the login's sites (exact host);
 *   3. the session's agent grant and allowlist admit the name;
 *   4. the login's audience reaches the session's person (shared or private
 *      session), through the same consumer path as every server consumer,
 *      which writes `secret.consumer.used` or `secret.consumer.denied`.
 *
 * Without `url`, the login is handed out for its first site and `url` is that
 * site's root, so agent-browser navigates there before it types.
 */
export async function resolveBrowserLogin(input: {
  projectId: string;
  accountId: string;
  sessionId: string;
  actorUserId: string | null;
  name: string;
  url: string | null;
}): Promise<BrowserLoginResolution> {
  const name = input.name.trim().toUpperCase();
  if (!isValidSecretName(name)) {
    return { ok: false, status: 400, code: 'login_name_invalid', error: `"${input.name}" is not a login name.` };
  }
  const urlHost = input.url ? loginUrlHost(input.url) : null;
  if (input.url && !urlHost) {
    return { ok: false, status: 400, code: 'login_url_invalid', error: 'url must be an http or https address.' };
  }
  // The token's session must belong to this project: a login is spent only
  // inside the project that stores it.
  const [session] = await db
    .select({ projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  if (!session || session.projectId !== input.projectId) {
    return { ok: false, status: 404, code: 'session_not_found', error: 'Session not found in this project.' };
  }

  // Every answer below is built only from the rows this session's person or
  // agent may reach. A login kept to someone else reads exactly like a missing
  // one: its existence and its sites are that person's business (CWE-200).
  const allRows = await sharedRowsNamed(input.projectId, name);
  const rows = await filterSecretRowsByAudience({
    projectId: input.projectId,
    accountId: input.accountId,
    subject: () =>
      secretAudienceSubject({
        projectId: input.projectId,
        accountId: input.accountId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
      }),
    rows: allRows,
  });
  const logins = rows.filter((row) => row.consumer === 'browser' && row.active);
  if (logins.length === 0) {
    const hidden = allRows.find((row) => row.consumer === 'browser' && row.active);
    if (hidden) {
      // Audited for the people who manage the workspace; the session learns nothing.
      await recordAuditEvent({
        accountId: input.accountId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        actorType: 'agent',
        source: 'browser',
        action: 'secret.consumer.denied',
        outcome: 'denied',
        resourceType: 'project_secret',
        resourceId: hidden.secretId,
        metadata: { name, site: urlHost, requested_consumer: 'browser', reason: 'not_in_audience' },
      });
    }
    return rows.length > 0
      ? {
          ok: false,
          status: 409,
          code: 'not_a_login',
          error: `${name} is a secret, not a website login. Ask for a login under another name: ${requestHint(`${name}_LOGIN`, urlHost ?? undefined)}`,
        }
      : {
          ok: false,
          status: 404,
          code: 'login_missing',
          error:
            `No website login named ${name} that this session may use. A login kept to one person works only in ` +
            `that person's private sessions. Otherwise ask the person for it: ${requestHint(name, urlHost ?? undefined)}`,
        };
  }
  const sitesById = new Map(
    logins.map((row) => [row.secretId, loginSitesOf(row.egressPolicy as Parameters<typeof loginSitesOf>[0])]),
  );
  if (input.url && !logins.some((row) => loginSiteAdmits(sitesById.get(row.secretId) ?? [], input.url!))) {
    const allowed = [...new Set([...sitesById.values()].flat())].join(', ');
    // A login asked for on another site is the one refusal that can mean a
    // page tried to phish it: audit it like every consumer decision.
    await recordAuditEvent({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      actorType: 'agent',
      source: 'browser',
      action: 'secret.consumer.denied',
      outcome: 'denied',
      resourceType: 'project_secret',
      resourceId: logins[0]!.secretId,
      metadata: { name, site: urlHost, requested_consumer: 'browser', reason: 'site_not_allowed' },
    });
    return {
      ok: false,
      status: 403,
      code: 'login_site_not_allowed',
      error: `${name} may be typed only on ${allowed || 'no site'}, not on ${urlHost}. Check the page. A person can add the site by entering the login again: ${requestHint(name, urlHost ?? undefined)}`,
    };
  }

  let reach: Awaited<ReturnType<typeof resolveSessionSecretReach>>;
  try {
    reach = await resolveSessionSecretReach(input.sessionId);
  } catch {
    return {
      ok: false,
      status: 503,
      code: 'login_grant_unreadable',
      error: "Kortix could not read this agent's secrets grant (kortix.yaml). Try again in a moment.",
    };
  }
  if (!reach) return { ok: false, status: 404, code: 'session_not_found', error: 'Session not found.' };
  const withheld = withheldSecrets([name], reach.grantEnv, reach.allowlist);
  if (withheld.length > 0) {
    return { ok: false, status: 403, code: 'login_not_granted', error: withheldSecretsFix(reach.agent, withheld) };
  }

  const resolved = await resolveProjectSecretForConsumer({
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    name,
    consumer: 'browser',
    admitPolicy: (policy) => {
      const sites = loginSitesOf(policy);
      return input.url ? loginSiteAdmits(sites, input.url) : sites.length > 0;
    },
    auditMetadata: { site: urlHost },
  });
  if (!resolved) {
    return {
      ok: false,
      status: 403,
      code: 'login_not_shared',
      error: `${name} is kept to a person this session does not act for (a shared session, a trigger, or another member). It works in that person's own private session. Do not ask for it again.`,
    };
  }
  const login = decodeBrowserLogin(resolved.value);
  if (!login) {
    return {
      ok: false,
      status: 409,
      code: 'login_damaged',
      error: `The stored value of ${name} is not a username and password. Ask the person to enter it again: ${requestHint(name, urlHost ?? undefined)}`,
    };
  }
  const site = sitesById.get(resolved.secretId)?.[0];
  return {
    ok: true,
    name,
    username: login.username,
    password: login.password,
    url: input.url ?? `https://${site}/`,
  };
}

export type BrowserLoginLinkSave =
  | { ok: true; saved: string[]; spent: number }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Save the logins a person typed into a `browser` setup link. Runs inside the
 * intake's transaction, after its tombstone, superseded and requester checks.
 * Every login is checked before any is written, so a refused field leaves no
 * partial save behind.
 *
 * A link replaces an existing login only when that row is a login and its
 * audience equals the one asked for now (see `browserLoginAudienceIs`). It
 * never turns an ordinary secret into a login.
 */
export async function saveBrowserLoginsFromLink(input: {
  projectId: string;
  fields: ReadonlyArray<{ name: string; sites?: string[] }>;
  logins: Record<string, unknown>;
  /** The member who asked, when the person keeps the login to them. */
  requesterId: string | null;
  accountId: string | null;
  createdBy: string | null;
  /** A row written after this moment spent the link (single use). */
  mintedAt: Date;
}): Promise<BrowserLoginLinkSave> {
  const planned: Array<{
    name: string;
    login: BrowserLoginValue;
    sites: string[];
    existing: { secretId: string } | null;
  }> = [];
  let spent = 0;
  for (const field of input.fields) {
    const name = field.name.toUpperCase();
    const raw = input.logins[name] ?? input.logins[field.name];
    if (raw === undefined || raw === null) continue;
    const parsed = parseBrowserLoginInput(raw);
    if (!parsed.ok) return { ok: false, status: 400, error: `${name}: ${parsed.error}` };
    const sites = normalizeLoginSites(field.sites);
    if (!sites.ok) return { ok: false, status: 400, error: `${name}: this link names no site. Ask the agent for a fresh link.` };
    const [written] = await db
      .select({ id: projectSecrets.secretId })
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, input.projectId),
          eq(projectSecrets.identifier, name),
          isNull(projectSecrets.ownerUserId),
          gt(projectSecrets.updatedAt, input.mintedAt),
        ),
      )
      .limit(1);
    if (written) {
      spent++;
      continue;
    }
    const existing = await sharedSecretRow(input.projectId, name);
    if (existing && existing.consumer !== 'browser') {
      return {
        ok: false,
        status: 409,
        error: `${name} is already a secret that is not a website login. Ask the agent for the login under another name.`,
      };
    }
    if (existing && !(await browserLoginAudienceIs(input.projectId, existing.secretId, input.requesterId))) {
      return {
        ok: false,
        status: 409,
        error: input.requesterId
          ? `${name} is a login other people can use. Keeping a new value to you would change theirs. Ask the agent for a login under another name.`
          : `${name} is a login kept to one person. Ask the agent for a login under another name.`,
      };
    }
    planned.push({ name, login: parsed.login, sites: sites.sites, existing });
  }

  const saved: string[] = [];
  for (const entry of planned) {
    // A NEW private login: write its audience first, under the id the row will
    // get, so the value is never open to everyone in between.
    const audience =
      !entry.existing && input.requesterId && input.accountId
        ? { accountId: input.accountId, requesterId: input.requesterId }
        : null;
    const pendingId = audience ? randomUUID() : undefined;
    if (audience && pendingId) {
      await setSecretAudience({
        accountId: audience.accountId,
        projectId: input.projectId,
        secretId: pendingId,
        principals: [{ principal_type: 'user', principal_id: audience.requesterId }],
        grantedBy: audience.requesterId,
        pending: true,
      });
    }
    const secretId = await writeBrowserLogin({
      projectId: input.projectId,
      name: entry.name,
      login: entry.login,
      sites: entry.sites,
      createdBy: input.createdBy,
      ...(pendingId ? { secretId: pendingId } : {}),
    });
    // A concurrent write made the name an ordinary secret: throw so the
    // intake transaction rolls back every login of this submission.
    if (!secretId) throw new Error(`${entry.name} became a secret that is not a website login`);
    saved.push(entry.name);
  }
  return { ok: true, saved, spent };
}

/**
 * What the requesting session is told after a person saved logins. It names
 * the one command that uses them, so the agent signs in instead of asking.
 */
export function browserLoginSavedPrompt(saved: string[], reach?: SessionWithheldSecrets | null): string {
  const one = saved.length === 1;
  // The chat shows this message, so it stays short; the rules for handling a
  // login are in the agent's credentials guide.
  const text =
    `The website ${one ? 'login' : 'logins'} ${saved.join(', ')} ${one ? 'was' : 'were'} saved. ` +
    'Sign in with `agent-browser auth login <profile> --credential-provider kortix --item ' +
    `${one ? saved[0] : '<NAME>'} --url <sign-in page URL>\`. Do not ask for it again.`;
  if (!reach || reach.withheld.length === 0) return text;
  return `${text} ${withheldSecretsFix(reach.agent, reach.withheld)} Tell the person this exact fix.`;
}
