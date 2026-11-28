import { describe, expect, test } from 'bun:test';
import { KORTIX_JSON_SCHEMA } from '@kortix/manifest-schema';
import {
  MANIFEST_SECTION_ACTIONS,
  MANIFEST_WRITE_ACTIONS,
  UNLISTED_SECTION_ACTION,
  refusesSelfMerge,
  requiredManifestActions,
  resolveChangeRequestBase,
  resolveChangeRequestOrigin,
  secretMergeRefusal,
} from './change-request-policy';

const SESSION = 'sess-a';
const OTHER = 'sess-b';

describe('resolveChangeRequestBase', () => {
  const base = { requested: null, sessionBase: null, projectDefault: 'main', actorIsSession: true };

  test('a session started from dev proposes into dev, not the project default', () => {
    // The reported bug, exactly: a `dev` session produced a CR into `main`.
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'dev' });
    expect(out).toEqual({ ok: true, baseRef: 'dev' });
  });

  test('falls back to the project default when the session has no base', () => {
    expect(resolveChangeRequestBase(base)).toEqual({ ok: true, baseRef: 'main' });
  });

  test('a CR with no session at all uses the project default', () => {
    const out = resolveChangeRequestBase({ ...base, actorIsSession: false });
    expect(out).toEqual({ ok: true, baseRef: 'main' });
  });

  test('an agent may NOT retarget its change request at another branch', () => {
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'dev', requested: 'main' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('CR_BASE_NOT_SESSION_BASE');
    // The message must name both branches so the agent can explain itself.
    expect(out.error).toContain('dev');
    expect(out.error).toContain('main');
  });

  test('an agent restating its own base is accepted, not refused', () => {
    // The CLI and the dashboard both send base_ref explicitly; echoing the
    // correct value must not be an error.
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'dev', requested: 'dev' });
    expect(out).toEqual({ ok: true, baseRef: 'dev' });
  });

  test('a PERSON may retarget — choosing where work lands is a review decision', () => {
    const out = resolveChangeRequestBase({
      ...base,
      sessionBase: 'dev',
      requested: 'release/1.2',
      actorIsSession: false,
    });
    expect(out).toEqual({ ok: true, baseRef: 'release/1.2' });
  });

  test('a person with no session context keeps an explicit base', () => {
    const out = resolveChangeRequestBase({
      ...base,
      requested: 'release/1.2',
      actorIsSession: false,
    });
    expect(out).toEqual({ ok: true, baseRef: 'release/1.2' });
  });

  test('an agent on a project whose default IS the session base is unaffected', () => {
    const out = resolveChangeRequestBase({ ...base, sessionBase: 'main', requested: 'main' });
    expect(out).toEqual({ ok: true, baseRef: 'main' });
  });
});

describe('refusesSelfMerge', () => {
  test('an ungoverned session may not merge the change request it opened', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: SESSION, hasExplicitMergeGrant: false })).toBe(true);
  });

  test('an explicitly granted session may merge the change request it opened', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: SESSION, hasExplicitMergeGrant: true })).toBe(false);
  });

  test('a session MAY merge a change request opened by someone else', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: OTHER, hasExplicitMergeGrant: false })).toBe(false);
  });

  test('a session may merge a change request a PERSON opened', () => {
    expect(refusesSelfMerge({ actingSessionId: SESSION, originSessionId: null, hasExplicitMergeGrant: false })).toBe(false);
  });

  test('a person is never refused', () => {
    expect(refusesSelfMerge({ actingSessionId: null, originSessionId: SESSION, hasExplicitMergeGrant: false })).toBe(false);
    expect(refusesSelfMerge({ actingSessionId: null, originSessionId: null, hasExplicitMergeGrant: false })).toBe(false);
  });

  test('two null ids are not treated as a match', () => {
    // Guards the obvious `a === b` bug: without the truthiness check, a person
    // merging a person-opened CR would be refused.
    expect(refusesSelfMerge({ actingSessionId: null, originSessionId: null, hasExplicitMergeGrant: false })).toBe(false);
  });
});

describe('resolveChangeRequestOrigin', () => {
  test('binds an omitted session_id to the authenticated session', () => {
    expect(resolveChangeRequestOrigin({ actorIsSession: true, actingSessionId: SESSION, requestedSessionId: null }))
      .toEqual({ ok: true, originSessionId: SESSION });
  });

  test('rejects a different session_id', () => {
    expect(resolveChangeRequestOrigin({ actorIsSession: true, actingSessionId: SESSION, requestedSessionId: OTHER }))
      .toMatchObject({ ok: false, code: 'CR_SESSION_ID_MISMATCH' });
  });

  test('requires authenticated session identity for an agent principal', () => {
    expect(resolveChangeRequestOrigin({ actorIsSession: true, actingSessionId: null, requestedSessionId: null }))
      .toMatchObject({ ok: false, code: 'CR_SESSION_ID_REQUIRED' });
  });

  test("keeps a person's supplied session origin", () => {
    expect(resolveChangeRequestOrigin({ actorIsSession: false, actingSessionId: null, requestedSessionId: SESSION }))
      .toEqual({ ok: true, originSessionId: SESSION });
  });
});


describe('requiredManifestActions — a merge needs what the direct route asserts', () => {
  const base = 'default_agent: a\nagents:\n  a:\n    kortix_permissions: ["project.read"]\n';
  const withTrigger = `${base}triggers:\n  - slug: hourly\n    type: cron\n    cron: "0 * * * *"\n    prompt: tidy\n    agent: a\n`;

  test('no section changed → nothing extra', () => {
    expect(requiredManifestActions(base, `# a comment\n${base}`)).toEqual([]);
    expect(requiredManifestActions(base, base)).toEqual([]);
    expect(requiredManifestActions(null, null)).toEqual([]);
  });

  test('widening an agent needs project.agent.write', () => {
    expect(requiredManifestActions(base, base.replace('["project.read"]', 'all'))).toEqual(['project.agent.write']);
    expect(requiredManifestActions(base, `${base}  b: {}\n`)).toEqual(['project.agent.write']);
  });

  test('triggers: added → create, edited → update, removed → delete', () => {
    expect(requiredManifestActions(base, withTrigger)).toEqual(['project.trigger.create']);
    expect(requiredManifestActions(withTrigger, withTrigger.replace('prompt: tidy', 'prompt: sweep'))).toEqual([
      'project.trigger.update',
    ]);
    expect(requiredManifestActions(withTrigger, base)).toEqual(['project.trigger.delete']);
  });

  test('switching default_agent needs project.agent.write', () => {
    const two = `${base}  b: {}\n`;
    expect(requiredManifestActions(two, two.replace('default_agent: a', 'default_agent: b'))).toEqual([
      'project.agent.write',
    ]);
  });

  test('key order and formatting do not count', () => {
    const reordered = 'agents:\n  a:\n    kortix_permissions: ["project.read"]\ndefault_agent: a\n';
    expect(requiredManifestActions(base, reordered)).toEqual([]);
  });

  test('a side that does not parse needs every manifest-write permission (fail closed)', () => {
    expect(requiredManifestActions(base, 'agents: [unclosed')).toEqual([...MANIFEST_WRITE_ACTIONS]);
    expect(MANIFEST_WRITE_ACTIONS).toContain('project.connector.write');
  });

  test('connectors: added, changed or removed → project.connector.write', () => {
    const desk = '  - slug: desk\n    provider: mcp\n    url: https://desk.example.test/mcp\n';
    const withDesk = `${base}connectors:\n${desk}`;
    expect(requiredManifestActions(base, withDesk)).toEqual(['project.connector.write']);
    expect(requiredManifestActions(withDesk, withDesk.replace('/mcp', '/v2/mcp'))).toEqual(['project.connector.write']);
    expect(requiredManifestActions(withDesk, base)).toEqual(['project.connector.write']);
    expect(requiredManifestActions(withDesk, `# a comment\n${withDesk}`)).toEqual([]);
  });

  test('workspace connector rules (policies, policy) → project.connector.write', () => {
    expect(requiredManifestActions(base, `${base}policies:\n  - match: send_*\n    action: block\n`)).toEqual([
      'project.connector.write',
    ]);
    expect(requiredManifestActions(base, `${base}policy:\n  default_mode: ask\n`)).toEqual(['project.connector.write']);
  });

  test("an agent's policy_sets → project.agent.write and project.connector.write, as on the direct agent routes", () => {
    const withSets = base.replace('    kortix_permissions: ["project.read"]\n', '    kortix_permissions: ["project.read"]\n    policy_sets: { gmail: read_only }\n');
    expect(requiredManifestActions(base, withSets)).toEqual(['project.agent.write', 'project.connector.write']);
    expect(requiredManifestActions(withSets, withSets.replace('read_only', 'everything'))).toEqual([
      'project.agent.write',
      'project.connector.write',
    ]);
    // Removing an agent that runs under a set removes the set.
    expect(requiredManifestActions(`${withSets}  b: {}\n`, 'default_agent: b\nagents:\n  b: {}\n')).toContain('project.connector.write');
    // Any other agent edit stays agent.write only.
    expect(requiredManifestActions(withSets, withSets.replace('["project.read"]', 'all'))).toEqual(['project.agent.write']);
  });

  test('apps → project.app.write; skills → project.skill.write', () => {
    expect(requiredManifestActions(base, `${base}apps:\n  site:\n    always_on: true\n`)).toEqual(['project.app.write']);
    expect(requiredManifestActions(base, `${base}skills:\n  triage: skills/triage\n`)).toEqual(['project.skill.write']);
    // Removing a registered skill also asks project.agent.write, as DELETE /skills does.
    expect(requiredManifestActions(`${base}skills:\n  triage: skills/triage\n`, base)).toEqual([
      'project.agent.write',
      'project.skill.write',
    ]);
    expect(MANIFEST_WRITE_ACTIONS).toEqual(expect.arrayContaining(['project.app.write', 'project.skill.write']));
  });

  test('sandbox → sandbox.write; tools and extensions → agent.write; project → settings.write; env → secret.write', () => {
    expect(requiredManifestActions(base, `${base}sandbox:\n  default: big\n`)).toEqual(['project.sandbox.write']);
    expect(requiredManifestActions(base, `${base}tools:\n  lookup: tools/lookup.ts\n`)).toEqual(['project.agent.write']);
    expect(requiredManifestActions(base, `${base}project:\n  name: renamed\n`)).toEqual(['project.settings.write']);
    expect(requiredManifestActions(base, `${base}env:\n  optional: [ORDERS_API_KEY]\n`)).toEqual(['project.secret.write']);
  });

  test('every top-level kortix.yaml key has a row; a key without one needs project.settings.write', () => {
    const rows = new Set(MANIFEST_SECTION_ACTIONS.map(([section]) => section));
    const keys = Object.keys((KORTIX_JSON_SCHEMA as { properties: Record<string, unknown> }).properties);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => key !== 'triggers' && !rows.has(key))).toEqual([]);
    expect(requiredManifestActions(base, `${base}some_future_key: 1\n`)).toEqual([UNLISTED_SECTION_ACTION]);
    for (const [, action] of MANIFEST_SECTION_ACTIONS) expect(MANIFEST_WRITE_ACTIONS as readonly string[]).toContain(action);
  });

  test('one change touching agents and connectors needs both', () => {
    const changed = `${base.replace('["project.read"]', 'all')}connectors:\n  - slug: desk\n    provider: mcp\n    url: https://desk.example.test/mcp\n`;
    expect(requiredManifestActions(base, changed)).toEqual(['project.agent.write', 'project.connector.write']);
  });
});

describe('secretMergeRefusal — a person may override, an agent may not', () => {
  const scan = {
    findings: [{ commit: '1a2b3c4d5e6f', file: 'src/config.ts', line: 2, rule: 'github_token', label: 'GitHub token' }],
    total: 1,
  };
  const input = { crNumber: 7, baseRef: 'main', scan, actorIsPerson: true, allowSecrets: false };

  test('nothing found → merges for everyone', () => {
    expect(secretMergeRefusal({ ...input, scan: { findings: [], total: 0 } })).toBeNull();
    expect(secretMergeRefusal({ ...input, scan: { findings: [], total: 0 }, actorIsPerson: false, allowSecrets: true })).toBeNull();
  });

  test('found, no override → 409 CR_SECRET_DETECTED naming file, line, commit and the fix', () => {
    for (const actorIsPerson of [true, false]) {
      const refusal = secretMergeRefusal({ ...input, actorIsPerson });
      expect(refusal?.status).toBe(409);
      expect(refusal?.body.code).toBe('CR_SECRET_DETECTED');
      expect(refusal?.body.findings).toEqual(scan.findings);
      expect(refusal?.body.error).toContain('src/config.ts:2 (GitHub token, commit 1a2b3c4d5e6f)');
      expect(refusal?.body.remediation).toContain('kortix secrets request <NAME>');
      expect(refusal?.body.remediation).toContain('origin/main');
      expect(refusal?.body.remediation).toContain('kortix cr merge 7 --allow-secrets');
    }
  });

  test('a person overrides → merges', () => {
    expect(secretMergeRefusal({ ...input, allowSecrets: true })).toBeNull();
  });

  test('nothing found but not read in full: a person merges as is; any other principal gets 409 CR_SECRET_SCAN_INCOMPLETE', () => {
    const incomplete = { findings: [], total: 0, unscanned: 'more than 500 commits' };
    expect(secretMergeRefusal({ ...input, scan: incomplete })).toBeNull();
    const refusal = secretMergeRefusal({ ...input, scan: incomplete, actorIsPerson: false });
    expect(refusal?.status).toBe(409);
    expect(refusal?.body.code).toBe('CR_SECRET_SCAN_INCOMPLETE');
    expect(refusal?.body.unscanned).toBe('more than 500 commits');
    expect(refusal?.body.remediation).toContain('ask a person to merge it');
    expect(secretMergeRefusal({ ...input, scan: incomplete, actorIsPerson: false, allowSecrets: true })?.body.code).toBe(
      'CR_SECRET_OVERRIDE_REFUSED',
    );
  });

  test('found and not read in full: a person still needs allow_secrets', () => {
    const both = { ...scan, unscanned: 'a patch over 32 MB' };
    expect(secretMergeRefusal({ ...input, scan: both })?.body.code).toBe('CR_SECRET_DETECTED');
    expect(secretMergeRefusal({ ...input, scan: both, allowSecrets: true })).toBeNull();
  });

  test('an agent session, a service account or a workspace key overrides → 403 CR_SECRET_OVERRIDE_REFUSED', () => {
    const refusal = secretMergeRefusal({ ...input, actorIsPerson: false, allowSecrets: true });
    expect(refusal?.status).toBe(403);
    expect(refusal?.body.code).toBe('CR_SECRET_OVERRIDE_REFUSED');
    expect(refusal?.body.findings).toEqual(scan.findings);
  });
});
