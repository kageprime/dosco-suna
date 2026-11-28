/**
 * Change-request authorization decisions that are ABOUT the session, not about
 * the caller's role — pure, no I/O, so both are testable and neither can drift
 * into a route handler where nobody finds it.
 *
 * These are the second half of the git ref policy. `git-proxy/ref-policy.ts`
 * stops a session pushing anywhere but its own branch; without the two rules
 * here that would be one hop from useless, because a change request is the
 * sanctioned way to move commits onto another branch and the merge writes that
 * branch SERVER-side, never passing through the proxy at all.
 */
import { parseManifestText } from '@kortix/manifest-schema';
import { describeSecretFindings, type SecretFinding, type SecretScan } from './secret-scan';

/** Which branch does a change request opened from a session target? */
export type CrBaseDecision =
  | { ok: true; baseRef: string }
  | { ok: false; code: string; error: string };

export function resolveChangeRequestBase(input: {
  /** `base_ref` as supplied by the caller, if any. */
  requested: string | null;
  /** The originating session's own base, when the CR is attached to a session. */
  sessionBase: string | null;
  /** The project's default branch. */
  projectDefault: string;
  /** True when the caller is a session/agent principal rather than a person. */
  actorIsSession: boolean;
}): CrBaseDecision {
  // A change request opened from a session targets the branch that session was
  // STARTED from — not the project default. Those differ whenever a team keeps
  // a long-lived branch as its trunk and the default branch for production: a
  // session branched off `dev` used to produce a change request into `main`,
  // proposing to ship to production work only ever meant for `dev`.
  const derived = input.sessionBase ?? input.projectDefault;
  if (!input.requested) return { ok: true, baseRef: derived };
  if (input.requested === derived) return { ok: true, baseRef: derived };
  // A person may retarget: choosing where work lands is a review decision, and
  // `kortix cr open --base` is how it is made. An agent may not — otherwise the
  // rule is advisory and the first thing a confused agent does is aim at main.
  if (input.actorIsSession) {
    return {
      ok: false,
      code: 'CR_BASE_NOT_SESSION_BASE',
      error:
        `This session was started from "${derived}", so its change request targets "${derived}" — ` +
        `it cannot be retargeted at "${input.requested}". ` +
        'Ask the user to open the change request against a different base.',
    };
  }
  return { ok: true, baseRef: input.requested };
}

/**
 * May this caller merge this change request?
 *
 * A session may merge its own change request only when its agent has an
 * explicit merge grant. Without this, an ungoverned agent (null grant) could
 * open and merge a change request to bypass the direct-push ref policy.
 *
 * A session merging a change request another actor opened still follows the
 * ordinary role and agent-scope gates on the route.
 */
export function refusesSelfMerge(input: {
  /** Session id of the acting token, or null for a person. */
  actingSessionId: string | null;
  /** The session the change request was opened from, if any. */
  originSessionId: string | null;
  /** Whether the agent's manifest explicitly grants project.gitops.merge. */
  hasExplicitMergeGrant: boolean;
}): boolean {
  return Boolean(input.actingSessionId)
    && input.actingSessionId === input.originSessionId
    && !input.hasExplicitMergeGrant;
}

/** Bind a session-opened CR to the authenticated session, not a body field. */
export function resolveChangeRequestOrigin(input: {
  actorIsSession: boolean;
  actingSessionId: string | null;
  requestedSessionId: string | null;
}): { ok: true; originSessionId: string | null } | { ok: false; code: string; error: string } {
  if (!input.actorIsSession) return { ok: true, originSessionId: input.requestedSessionId };
  if (!input.actingSessionId) {
    return { ok: false, code: 'CR_SESSION_ID_REQUIRED', error: 'Session identity is required.' };
  }
  if (input.requestedSessionId && input.requestedSessionId !== input.actingSessionId) {
    return {
      ok: false,
      code: 'CR_SESSION_ID_MISMATCH',
      error: 'session_id must match the authenticated session.',
    };
  }
  return { ok: true, originSessionId: input.actingSessionId };
}

/**
 * A merge needs what the direct write of each section it changes needs, for an
 * agent as for a person. One row per top-level `kortix.yaml` key, with the
 * permission its direct writer asserts; a key with no dedicated route gets the
 * permission of what it configures. `agents.<name>.policy_sets` is the one
 * field whose writer asks more than its section (`agent-config.ts`,
 * `agent-scope.ts`); triggers ask create, update or delete by what changed. A
 * key this table does not name (a key added to the schema later) needs
 * `UNLISTED_SECTION_ACTION`, and `change-request-policy.test.ts` fails until
 * the schema's every key has a row.
 *
 * The Manager role holds every one of these; the web role editor adds them to a
 * role that gets `project.gitops.merge` (its catalog `implies`), but the API
 * accepts a custom role without them, so the merge asks. An agent's
 * `kortix_permissions` list is flat, so it must name them (or `all`).
 */
export const MANIFEST_SECTION_ACTIONS: ReadonlyArray<readonly [section: string, action: string]> = [
  // PUT /agents/:name/config|scope, PUT /default-agent; what every agent loads
  ['agents', 'project.agent.write'],
  ['default_agent', 'project.agent.write'],
  ['builtin_agents', 'project.agent.write'],
  ['tools', 'project.agent.write'],
  ['extensions', 'project.agent.write'],
  ['evals', 'project.agent.write'],
  // POST|DELETE /connectors, PUT /connectors/:slug/*, PUT /policies (connectors/manifest-*.ts)
  ['connectors', 'project.connector.write'],
  ['policies', 'project.connector.write'],
  ['policy', 'project.connector.write'],
  ['approvals', 'project.connector.write'],
  // App create and PATCH (apps/app-manifest.ts, apps/route-access.ts)
  ['apps', 'project.app.write'],
  // Skill registration (projects/routes/project-skills.ts); removing one also
  // asks project.agent.write, as its route does (below)
  ['skills', 'project.skill.write'],
  ['commands', 'project.command.write'],
  // POST|PATCH|DELETE /sandbox-templates
  ['sandbox', 'project.sandbox.write'],
  ['sandboxes', 'project.sandbox.write'], // deprecated spelling of sandbox.templates
  // The secret names sessions receive
  ['env', 'project.secret.write'],
  ['trigger_session_readers', 'project.trigger.update'],
  // PATCH /projects/:id (manifest-project-name.ts) and the file's own shape
  ['project', 'project.settings.write'],
  ['spaces', 'project.settings.write'],
  ['runtime', 'project.settings.write'],
  ['imports', 'project.settings.write'],
  ['kortix_version', 'project.settings.write'],
];

/** What a change to a top-level key with no row in `MANIFEST_SECTION_ACTIONS` needs. */
export const UNLISTED_SECTION_ACTION = 'project.settings.write';

/**
 * Every permission `requiredManifestActions` can ask. A session's push straight
 * to the default branch skips the merge, so it needs all of them
 * (git-proxy/ref-policy.ts).
 */
export const MANIFEST_WRITE_ACTIONS = [
  'project.agent.write',
  'project.trigger.create',
  'project.trigger.update',
  'project.trigger.delete',
  'project.connector.write',
  'project.app.write',
  'project.skill.write',
  'project.command.write',
  'project.sandbox.write',
  'project.secret.write',
  'project.settings.write',
] as const;

const SECTION_ACTION = new Map(MANIFEST_SECTION_ACTIONS);

/**
 * Which of `MANIFEST_WRITE_ACTIONS` moving the manifest from `baseText` to
 * `headText` needs. Compared on parsed values, so formatting and key order do
 * not count. `null` = no manifest on that side. A side that does not parse
 * needs every one of them: the check fails closed.
 */
export function requiredManifestActions(baseText: string | null, headText: string | null): string[] {
  const read = (text: string | null): Record<string, unknown> | null => {
    if (text === null || !text.trim()) return {};
    try {
      return parseManifestText(text);
    } catch {
      return null;
    }
  };
  const before = read(baseText);
  const after = read(headText);
  if (before === null || after === null) return [...MANIFEST_WRITE_ACTIONS];
  const required = new Set<string>();
  for (const section of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (section === 'triggers') continue;
    if (canonicalJson(before[section]) === canonicalJson(after[section])) continue;
    required.add(SECTION_ACTION.get(section) ?? UNLISTED_SECTION_ACTION);
  }
  if (policySetsChanged(before.agents, after.agents)) required.add('project.connector.write');
  if (keysRemoved(before.skills, after.skills)) required.add('project.agent.write');
  const was = triggersByKey(before.triggers);
  const now = triggersByKey(after.triggers);
  for (const [key, value] of now) {
    if (!was.has(key)) required.add('project.trigger.create');
    else if (was.get(key) !== value) required.add('project.trigger.update');
  }
  for (const key of was.keys()) if (!now.has(key)) required.add('project.trigger.delete');
  return MANIFEST_WRITE_ACTIONS.filter((action) => required.has(action));
}

/** Does `after` lack a key `before` has? A `skills` registry is a map (or a list of names). */
function keysRemoved(before: unknown, after: unknown): boolean {
  const keysOf = (value: unknown): Set<string> => {
    if (Array.isArray(value)) return new Set(value.map((item) => canonicalJson(item)));
    if (value && typeof value === 'object') return new Set(Object.keys(value));
    return new Set();
  };
  const now = keysOf(after);
  return [...keysOf(before)].some((key) => !now.has(key));
}

/**
 * Does any agent's `policy_sets` differ? An agent added or removed with a set
 * counts: deleting an agent and declaring it again must not move it onto the
 * base rules (the same rule as `changedPolicySet` in iam/agent-grant-ceiling.ts).
 */
function policySetsChanged(before: unknown, after: unknown): boolean {
  const setsOf = (agents: unknown): Map<string, string> => {
    const out = new Map<string, string>();
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return out;
    for (const [name, spec] of Object.entries(agents as Record<string, unknown>)) {
      const sets = spec && typeof spec === 'object' ? (spec as Record<string, unknown>).policy_sets : undefined;
      out.set(name, canonicalJson(sets ?? null));
    }
    return out;
  };
  const was = setsOf(before);
  const now = setsOf(after);
  for (const name of new Set([...was.keys(), ...now.keys()])) {
    if ((was.get(name) ?? 'null') !== (now.get(name) ?? 'null')) return true;
  }
  return false;
}

/** Triggers keyed by slug (a list of `{slug}` or a slug-keyed map), each as canonical JSON. */
function triggersByKey(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const slug = item && typeof item === 'object' ? (item as Record<string, unknown>).slug : undefined;
      out.set(typeof slug === 'string' ? slug : `#${index}`, canonicalJson(item));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) out.set(key, canonicalJson(item));
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The refusal body of a merge the secret check stops. Never carries a value. */
export interface SecretMergeRefusalBody {
  error: string;
  code: 'CR_SECRET_DETECTED' | 'CR_SECRET_SCAN_INCOMPLETE' | 'CR_SECRET_OVERRIDE_REFUSED';
  findings: SecretFinding[];
  findings_total: number;
  /** Why the scan could not read the whole change, when it could not. */
  unscanned?: string;
  remediation: string;
}

/**
 * May a change whose commits add what looks like a secret merge?
 *
 * - Nothing found and everything read: yes.
 * - Found: 409 `CR_SECRET_DETECTED`. A person who checked the finding (a test
 *   fixture, a public key the rule cannot tell apart) overrides with
 *   `allow_secrets`.
 * - Nothing found, but the scan could not read it all (`scan.unscanned`: a
 *   long-lived trunk merged into main is over the bounds): a person merges it
 *   as is, and the route records the skipped check. Any other principal gets
 *   409 `CR_SECRET_SCAN_INCOMPLETE`: unread is not clean for automation.
 *
 * An override from anything but a person — an agent session, the principal
 * the check exists for, or a service account, workspace key or OAuth token —
 * answers 403 `CR_SECRET_OVERRIDE_REFUSED`.
 */
export function secretMergeRefusal(input: {
  crNumber: number;
  baseRef: string;
  scan: SecretScan;
  /** The person's full identity (iam/person-credential.ts), not a session or automation. */
  actorIsPerson: boolean;
  allowSecrets: boolean;
}): { status: 403 | 409; body: SecretMergeRefusalBody } | null {
  const found = input.scan.total > 0;
  if (!found && !input.scan.unscanned) return null;
  if (input.actorIsPerson && (input.allowSecrets || !found)) return null;
  const override = `\`kortix cr merge ${input.crNumber} --allow-secrets\``;
  const what = found
    ? `adds what looks like a secret: ${describeSecretFindings(input.scan)}`
    : `is too large to check for secrets (${input.scan.unscanned})`;
  const remediation = found
    ? 'Store the value as a Kortix secret (`kortix secrets request <NAME>`) and read it from the environment. ' +
      `Then remove it from every commit of the branch: \`git reset --soft $(git merge-base origin/${input.baseRef} HEAD)\`, ` +
      'commit again, `git push --force-with-lease origin HEAD`. ' +
      `A person who checked the finding may merge anyway: ${override}.`
    : 'Split it into smaller change requests, or ask a person to merge it: their merge records the skipped check.';
  const common = {
    findings: input.scan.findings,
    findings_total: input.scan.total,
    ...(input.scan.unscanned ? { unscanned: input.scan.unscanned } : {}),
    remediation,
  };
  if (input.allowSecrets) {
    return {
      status: 403,
      body: {
        error:
          `Change request #${input.crNumber} ${what}. ` +
          (found
            ? `Only a person merges past the secret check: ask one to review it and run ${override}.`
            : 'Only a person merges a change the secret check could not read: ask one to merge it.') +
          ' Nothing was merged.',
        code: 'CR_SECRET_OVERRIDE_REFUSED',
        ...common,
      },
    };
  }
  return {
    status: 409,
    body: {
      error: `Change request #${input.crNumber} ${what}. Nothing was merged.`,
      code: found ? 'CR_SECRET_DETECTED' : 'CR_SECRET_SCAN_INCOMPLETE',
      ...common,
    },
  };
}
