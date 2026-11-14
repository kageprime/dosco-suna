/**
 * Colleague access: connectors and project secrets My Kortix hands one
 * colleague (an inline child that runs as My Kortix, inline-colleague.ts).
 *
 * My Kortix holds every connector and secret its person can use
 * (`myKortixAgentGrant`), and an inline colleague inherits that. The list below
 * still exists for a narrower grant (a session that predates it, or a
 * disabled My Kortix). A colleague's extra list is allowed or denied first:
 *
 *   1. The start names a list nobody allowed yet: the API records an ask
 *      (`session_colleague_access`) and answers 409
 *      `COLLEAGUE_ACCESS_APPROVAL_REQUIRED`. No session exists.
 *   2. The person allows or denies it in the chat or in Review
 *      (`POST /asks/access:<id>/answer`). Only a person decides: the routes
 *      refuse an agent's token. My Kortix hears the decision as a new message.
 *   3. My Kortix starts the colleague again with the same list. The create
 *      consumes the allow once, in the same transaction as the session row,
 *      and the colleague's grant is My Kortix's plus that list on every turn
 *      (`withColleagueAccess`).
 *
 * Only the API writes the table. The permission asks a box relays
 * (`session_pending_permissions`) carry a hash the box chose, so they never
 * stand in for this approval.
 *
 * A member may hand out only what an enabled agent of the project already
 * holds: `kortix.yaml` agent grants are the only gate on connectors and
 * secrets, and a member cannot edit them. A project manager may allow any
 * connector or secret of the project.
 */
import { createHash } from 'node:crypto';
import type { AgentGrant } from '@kortix/db';
import { connectors as connectorsTable, sessionColleagueAccess } from '@kortix/db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { agentMayUseConnector, agentMayUseEnv } from '../../iam/agent-scope';
import { canonicalConnectorAlias } from '../../shared/connector-alias';
import { db } from '../../shared/db';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { loadProjectAgents } from '../agents';
import { grantFromLoadedAgents } from '../agents/grants';
import type { LoadedAgents } from '../agents/types';
import { listResolvedProjectSecrets, secretKeyCollisionInAllowlist } from '../secrets';
import { myKortixAgentGrant } from './my-kortix-agent';

/** The create body key. */
const COLLEAGUE_ACCESS_BODY_KEY = 'colleague_access';
/** Items per list. A colleague that needs more is a project agent. */
export const COLLEAGUE_ACCESS_MAX_ITEMS = 20;
/** An open ask, and an allow nobody used, close after this. */
const COLLEAGUE_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
/** The 409 a start answers while its list waits for a person. */
export const COLLEAGUE_ACCESS_APPROVAL_REQUIRED = 'COLLEAGUE_ACCESS_APPROVAL_REQUIRED';

const ITEM = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** A colleague's own connectors and secrets: sorted, no duplicates. */
export interface ColleagueAccess {
  connectors: string[];
  secrets: string[];
}

export type ColleagueAccessDecision = 'allow' | 'deny';

type ColleagueAccessParse = { ok: true; value: ColleagueAccess | null } | { ok: false; error: string };

function parseList(raw: unknown, field: string, canonical: (value: string) => string): string[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `${field} must be an array of names`;
  if (raw.length > COLLEAGUE_ACCESS_MAX_ITEMS) return `${field} takes at most ${COLLEAGUE_ACCESS_MAX_ITEMS} names`;
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !ITEM.test(item.trim())) return `${field} has an invalid name: ${JSON.stringify(item)}`;
    out.add(canonical(item.trim()));
  }
  return [...out].sort();
}

/**
 * The body's `colleague_access`. Null: no access asked (absent, or both lists
 * empty). Connector names are canonical slugs; secret identifiers keep their
 * case here and take the stored case in `checkColleagueAccessItems`. Pure.
 */
export function parseColleagueAccess(raw: unknown): ColleagueAccessParse {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'colleague_access must be an object' };
  const unknownKeys = Object.keys(raw).filter((key) => key !== 'connectors' && key !== 'secrets');
  if (unknownKeys.length) return { ok: false, error: `colleague_access takes connectors and secrets, not ${unknownKeys.join(', ')}` };
  const value = raw as Record<string, unknown>;
  const connectors = parseList(value.connectors, 'colleague_access.connectors', canonicalConnectorAlias);
  if (typeof connectors === 'string') return { ok: false, error: connectors };
  const secrets = parseList(value.secrets, 'colleague_access.secrets', (s) => s);
  if (typeof secrets === 'string') return { ok: false, error: secrets };
  if (connectors.length === 0 && secrets.length === 0) return { ok: true, value: null };
  return { ok: true, value: { connectors, secrets } };
}

/** The key a re-run matches: the sorted lists, secret identifiers in upper case. Pure. */
export function colleagueAccessHash(access: ColleagueAccess): string {
  const canonical = JSON.stringify([access.connectors, access.secrets.map((s) => s.toUpperCase()).sort()]);
  return createHash('sha256').update(`kortix.colleague-access.v1\n${canonical}`).digest('hex');
}

function union(base: string[] | 'all' | undefined, extra: string[]): string[] | 'all' {
  if (base === 'all') return 'all';
  return [...new Set([...(base ?? []), ...extra])];
}

/**
 * A colleague's grant: its agent's grant plus the list a person allowed.
 * Null access: the grant unchanged. Never narrows; never widens `permissions`
 * or `apps`. Pure.
 */
export function withColleagueAccess(grant: AgentGrant, access: ColleagueAccess | null): AgentGrant {
  if (!access) return grant;
  return {
    ...grant,
    connectors: union(grant.connectors, access.connectors),
    // An absent `env` is every secret (grants minted before the field existed).
    env: union(grant.env ?? 'all', access.secrets),
  };
}

/**
 * The items of `access` that no enabled agent of the project holds, as
 * "connector <slug>" / "secret <identifier>". Only a project manager may allow
 * those. A project without per-agent grants holds everything. Pure.
 */
export function itemsNoAgentHolds(loaded: LoadedAgents, access: ColleagueAccess): string[] {
  if (loaded.specs.length === 0 && loaded.errors.length === 0) return [];
  const grants = loaded.specs.filter((spec) => spec.enabled).map((spec) => grantFromLoadedAgents(spec.name, loaded));
  const held = (check: (grant: AgentGrant | null) => boolean) => grants.some(check);
  return [
    ...access.connectors.filter((slug) => !held((g) => agentMayUseConnector(g, slug))).map((slug) => `connector ${slug}`),
    ...access.secrets.filter((id) => !held((g) => agentMayUseEnv(g, id))).map((id) => `secret ${id}`),
  ];
}

type ColleagueAccessItemsCheck =
  | { ok: true; access: ColleagueAccess }
  | { ok: false; status: 404 | 409; body: Record<string, unknown> };

/**
 * Every item names something that exists: an enabled connector of the
 * project, and a runtime secret the person may receive. Secret identifiers
 * take their stored case. The answer names what exists, so the agent can fix
 * its list.
 */
export async function checkColleagueAccessItems(input: {
  projectId: string;
  userId: string;
  access: ColleagueAccess;
}): Promise<ColleagueAccessItemsCheck> {
  const { projectId, userId, access } = input;
  if (access.connectors.length) {
    const rows = await db
      .select({ slug: connectorsTable.slug })
      .from(connectorsTable)
      .where(and(eq(connectorsTable.projectId, projectId), eq(connectorsTable.enabled, true)));
    const known = new Set(rows.map((row) => canonicalConnectorAlias(row.slug)));
    const missing = access.connectors.filter((slug) => !known.has(slug));
    if (missing.length) {
      return {
        ok: false,
        status: 404,
        body: {
          error: `No enabled connector named ${missing.join(', ')} in this workspace. Connectors: ${[...known].sort().join(', ') || 'none'}.`,
          code: 'COLLEAGUE_ACCESS_UNKNOWN_CONNECTOR',
          connectors: [...known].sort(),
        },
      };
    }
  }
  let secrets = access.secrets;
  if (secrets.length) {
    const resolved = await listResolvedProjectSecrets(projectId, userId, { personId: userId, agentId: null });
    const byUpper = new Map(resolved.map((secret) => [secret.identifier.toUpperCase(), secret.identifier]));
    const missing = secrets.filter((id) => !byUpper.has(id.toUpperCase()));
    if (missing.length) {
      const names = [...new Set(resolved.map((secret) => secret.identifier))].sort();
      return {
        ok: false,
        status: 404,
        body: {
          error: `No secret named ${missing.join(', ')} that this person can use. Secrets: ${names.join(', ') || 'none'}.`,
          code: 'COLLEAGUE_ACCESS_UNKNOWN_SECRET',
          secrets: names,
        },
      };
    }
    secrets = [...new Set(secrets.map((id) => byUpper.get(id.toUpperCase())!))].sort();
    const collision = secretKeyCollisionInAllowlist(resolved, secrets);
    if (collision) {
      return {
        ok: false,
        status: 409,
        body: {
          error: `Secrets ${collision.identifiers.join(', ')} all set the env var ${collision.key}. Name one of them.`,
          code: 'COLLEAGUE_ACCESS_SECRET_COLLISION',
        },
      };
    }
  }
  return { ok: true, access: { connectors: access.connectors, secrets } };
}

/** An allow of this list for this session that no start used yet. Null: none. */
export async function findColleagueAccessAllow(sessionId: string, accessHash: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sessionColleagueAccess.id })
    .from(sessionColleagueAccess)
    .where(
      and(
        eq(sessionColleagueAccess.sessionId, sessionId),
        eq(sessionColleagueAccess.accessHash, accessHash),
        eq(sessionColleagueAccess.decision, 'allow'),
        isNull(sessionColleagueAccess.consumedAt),
        gt(sessionColleagueAccess.expiresAt, sql`NOW()`),
      ),
    )
    .orderBy(sessionColleagueAccess.decidedAt)
    .limit(1);
  return row?.id ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Use an allow for the colleague `colleagueSessionId`, inside the create's
 * transaction. Compare-and-set: two starts never share one allow. False:
 * another start used it first, or it expired.
 */
export async function consumeColleagueAccessAllow(tx: Tx, input: { id: string; colleagueSessionId: string }): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await tx
    .update(sessionColleagueAccess)
    .set({ consumedAt: now, consumedBySessionId: input.colleagueSessionId, updatedAt: now })
    .where(
      and(
        eq(sessionColleagueAccess.id, input.id),
        eq(sessionColleagueAccess.decision, 'allow'),
        isNull(sessionColleagueAccess.consumedAt),
        gt(sessionColleagueAccess.expiresAt, sql`NOW()`),
      ),
    )
    .returning({ id: sessionColleagueAccess.id });
  return rows.length > 0;
}

/**
 * Record the ask, or refresh the open one for the same list: one card per
 * list, never two. An expired open ask opens again with a new expiry.
 */
export async function askColleagueAccess(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  surfaceSessionId: string;
  title: string;
  access: ColleagueAccess;
  accessHash: string;
  now?: Date;
}): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + COLLEAGUE_ACCESS_TTL_MS).toISOString();
  const [row] = await db
    .insert(sessionColleagueAccess)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      surfaceSessionId: input.surfaceSessionId,
      title: input.title.slice(0, 200),
      connectors: input.access.connectors as never,
      secrets: input.access.secrets as never,
      accessHash: input.accessHash,
      askedAt: now.toISOString(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [sessionColleagueAccess.sessionId, sessionColleagueAccess.accessHash],
      targetWhere: sql`decided_at IS NULL`,
      set: {
        title: input.title.slice(0, 200),
        // Still open: keep its expiry. Expired: open it again.
        askedAt: sql`CASE WHEN ${sessionColleagueAccess.expiresAt} <= NOW() THEN ${now.toISOString()}::timestamptz ELSE ${sessionColleagueAccess.askedAt} END`,
        expiresAt: sql`CASE WHEN ${sessionColleagueAccess.expiresAt} <= NOW() THEN ${expiresAt}::timestamptz ELSE ${sessionColleagueAccess.expiresAt} END`,
        updatedAt: now.toISOString(),
      },
    })
    .returning({ id: sessionColleagueAccess.id });
  if (!row) throw new Error('colleague access ask insert returned no row');
  return row;
}

/**
 * A My Kortix session's grant: My Kortix's own, plus the list a person allowed
 * when it is a colleague.
 *
 * With the session's project git context, the base grant resolves through
 * `grantFromLoadedAgents` — the SAME rule the per-prompt re-mint and the boot
 * secret resolver use — so repair mode (an unparseable kortix.yaml) closes the
 * secret leg here too. Without it, a My Kortix session BOOTED holding every
 * project secret its person can use: the mint and the boot env read this
 * function, and neither consulted the manifest, so only the first prompt's
 * re-mint narrowed them, after the values were already in the box
 * (secret-grant.ts's header: the residue is irreversible).
 *
 * Only `env` narrows; permissions and connectors stay person-capped 'all' so
 * the broken file can still be repaired through the project's own tooling. A
 * load that did not come back at all (`manifest` absent: a git blip, a broken
 * `imports:`) closes the secret leg the same way — the resolver refuses that
 * same load outright, and the boot mint must not answer it with the env list
 * it cannot prove.
 */
export async function myKortixSessionGrant(
  sessionId: string,
  project?: MyKortixProjectGitContext,
): Promise<AgentGrant> {
  // Without the git context nothing can be read, so the manifest cannot be
  // broken and the platform-owned grant stands.
  if (!project?.defaultBranch) {
    return withColleagueAccess(myKortixAgentGrant(), await readColleagueAccess(sessionId));
  }
  const loaded = await loadProjectAgents(
    {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      manifestPath: project.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    },
    // The resolver's own option: a load that does not come back — a git
    // blip, an unresolvable ref, a broken `imports:` — THROWS instead of
    // being laundered into the synthesized permissive manifest, and the
    // catch below refuses the secret leg exactly as the resolver refuses
    // the same load.
    { rethrowReadErrors: true, forceRefresh: 'tip-proof' },
  ).catch(() => null);
  // The load did not come back: nothing can be proven about any grant, so the
  // secret leg closes (the resolver answers the same load with
  // `SecretGrantResolutionError`). My Kortix keeps the platform grant for
  // permissions and connectors so the file stays repairable; only the env
  // list we cannot prove is withheld.
  if (!loaded) return withColleagueAccess({ ...myKortixAgentGrant(), env: [] }, await readColleagueAccess(sessionId));
  // A manifest that was READ and is not YAML takes `grantFromLoadedAgents`'s
  // repair answer — the resolver's own rule — and ONLY here: an unconditional
  // call would also answer `disabledMyKortixAgentGrant` for a project with
  // `my_kortix` off, while this mint has always given My Kortix its
  // platform-owned grant.
  const base = loaded.manifestSyntaxError
    ? (grantFromLoadedAgents(MY_KORTIX_AGENT_NAME, loaded) ?? myKortixAgentGrant())
    : myKortixAgentGrant();
  return withColleagueAccess(base, await readColleagueAccess(sessionId));
}

/** The git context a My Kortix grant needs to consult the manifest. */
type MyKortixProjectGitContext = {
  projectId: string;
  repoUrl: string;
  /** Absent/empty: no manifest can be read, so nothing can be in repair mode. */
  defaultBranch: string | null | undefined;
  manifestPath: string | null | undefined;
};

/** The list a person allowed for this colleague session. Null: none (any other session). */
export async function readColleagueAccess(sessionId: string): Promise<ColleagueAccess | null> {
  const [row] = await db
    .select({ connectors: sessionColleagueAccess.connectors, secrets: sessionColleagueAccess.secrets })
    .from(sessionColleagueAccess)
    .where(and(eq(sessionColleagueAccess.consumedBySessionId, sessionId), eq(sessionColleagueAccess.decision, 'allow')))
    .limit(1);
  if (!row) return null;
  return { connectors: stringList(row.connectors), secrets: stringList(row.secrets) };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export interface ColleagueAccessAsk {
  id: string;
  accountId: string;
  projectId: string;
  sessionId: string;
  surfaceSessionId: string | null;
  title: string;
  connectors: string[];
  secrets: string[];
  askedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decision: ColleagueAccessDecision | null;
}

const askColumns = {
  id: sessionColleagueAccess.id,
  accountId: sessionColleagueAccess.accountId,
  projectId: sessionColleagueAccess.projectId,
  sessionId: sessionColleagueAccess.sessionId,
  surfaceSessionId: sessionColleagueAccess.surfaceSessionId,
  title: sessionColleagueAccess.title,
  connectors: sessionColleagueAccess.connectors,
  secrets: sessionColleagueAccess.secrets,
  askedAt: sessionColleagueAccess.askedAt,
  expiresAt: sessionColleagueAccess.expiresAt,
  decidedAt: sessionColleagueAccess.decidedAt,
  decision: sessionColleagueAccess.decision,
};

function shaped(row: { connectors: unknown; secrets: unknown; decision: string | null } & Omit<ColleagueAccessAsk, 'connectors' | 'secrets' | 'decision'>): ColleagueAccessAsk {
  return {
    ...row,
    connectors: stringList(row.connectors),
    secrets: stringList(row.secrets),
    decision: row.decision === 'allow' || row.decision === 'deny' ? row.decision : null,
  };
}

/** Open, unexpired asks of a project, newest first. */
export async function listOpenColleagueAccessAsks(input: {
  projectId: string;
  sessionIds?: readonly string[];
  limit: number;
}): Promise<ColleagueAccessAsk[]> {
  if (input.sessionIds && input.sessionIds.length === 0) return [];
  const rows = await db
    .select(askColumns)
    .from(sessionColleagueAccess)
    .where(
      and(
        eq(sessionColleagueAccess.projectId, input.projectId),
        isNull(sessionColleagueAccess.decidedAt),
        gt(sessionColleagueAccess.expiresAt, sql`NOW()`),
        input.sessionIds ? inArray(sessionColleagueAccess.sessionId, [...input.sessionIds]) : undefined,
      ),
    )
    .orderBy(desc(sessionColleagueAccess.askedAt))
    .limit(input.limit);
  return rows.map(shaped);
}

export async function getColleagueAccessAsk(projectId: string, id: string): Promise<ColleagueAccessAsk | null> {
  const [row] = await db
    .select(askColumns)
    .from(sessionColleagueAccess)
    .where(and(eq(sessionColleagueAccess.id, id), eq(sessionColleagueAccess.projectId, projectId)))
    .limit(1);
  return row ? shaped(row) : null;
}

/** Decide an open ask. Compare-and-set: two people deciding at once make one decision. False: decided or expired. */
export async function decideColleagueAccessAsk(input: {
  id: string;
  decision: ColleagueAccessDecision;
  decidedBy: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await db
    .update(sessionColleagueAccess)
    .set({ decidedAt: now, decision: input.decision, decidedBy: input.decidedBy, updatedAt: now })
    .where(
      and(
        eq(sessionColleagueAccess.id, input.id),
        isNull(sessionColleagueAccess.decidedAt),
        gt(sessionColleagueAccess.expiresAt, sql`NOW()`),
      ),
    )
    .returning({ id: sessionColleagueAccess.id });
  return rows.length > 0;
}

/** "connectors gmail, slack and secrets STRIPE_KEY". Pure. */
export function describeColleagueAccess(access: Pick<ColleagueAccess, 'connectors' | 'secrets'>): string {
  const parts = [
    access.connectors.length ? `${access.connectors.length === 1 ? 'connector' : 'connectors'} ${access.connectors.join(', ')}` : '',
    access.secrets.length ? `${access.secrets.length === 1 ? 'secret' : 'secrets'} ${access.secrets.join(', ')}` : '',
  ].filter(Boolean);
  return parts.join(' and ');
}

/** What the agent reads when its start waits for a person. Pure. */
export function colleagueAccessPendingText(access: ColleagueAccess): string {
  return (
    `The person must allow this colleague's access first (${describeColleagueAccess(access)}). ` +
    'A card asks them now, in this chat and in Review. No colleague started. ' +
    'Tell them in one line what the colleague needs and why, then end your turn. ' +
    'Their decision arrives as a new message. Do not start the colleague again before it does.'
  );
}

/** The message My Kortix hears when a person decided. Pure. */
export function renderColleagueAccessDecision(ask: Pick<ColleagueAccessAsk, 'title' | 'connectors' | 'secrets'>, decision: ColleagueAccessDecision): string {
  const what = describeColleagueAccess(ask);
  if (decision === 'deny') {
    return (
      `The person denied the access you asked for the colleague "${ask.title}" (${what}). ` +
      'Do not start a colleague with that access. Continue without it, or ask them what they want instead.'
    );
  }
  return (
    `The person allowed the access you asked for the colleague "${ask.title}" (${what}). ` +
    'Start that colleague now: call agent again with the same inline agent spec, the same connectors and the same secrets. ' +
    'The allow is used once.'
  );
}
