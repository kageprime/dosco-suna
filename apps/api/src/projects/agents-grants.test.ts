/**
 * Characterization pins for the grant resolution this module must preserve,
 * plus the one intended change: a governed project's grant
 * (`resolveGovernedAgentGrant`, subject) now canonicalizes the manifest's
 * spellings exactly like `grantFromLoadedAgents` always did.
 *
 * The pins use alias spellings (`email`, `project.cr.open`) where the point is
 * canonicalization, so the pins exercise the rewriting itself, not just
 * pass-through. Grants built from already-canonical spellings are pinned too.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_AGENT_SENTINEL,
  agentGrantAllowsRepository,
  extractAgents,
  grantFromLoadedAgents,
  resolveGovernedAgentGrant,
} from './agents';
import { parseManifestString } from './triggers';

const v2 = (block: string) => parseManifestString(`default_agent: w\nagents:\n  w:\n${block}`, 'kortix.yaml');

describe('characterization — governed grant resolution pins', () => {
  test('a concrete agent resolves to its declared grant', () => {
    const loaded = extractAgents(
      v2('    connectors: [github]\n    kortix_permissions: [project.read]\n'),
    );
    expect(loaded.errors).toEqual([]);
    const governed = resolveGovernedAgentGrant('w', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    expect(governed.grant).toEqual({
      agent: 'w',
      permissions: ['project.read'],
      connectors: ['github'],
      env: [],
    });
  });

  test("the `default` sentinel resolves to the declared default agent's grant", () => {
    const loaded = extractAgents(
      v2('    connectors: [github]\n    kortix_permissions: [project.read]\n'),
    );
    const governed = resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, loaded, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    expect(governed.grant).toEqual({
      agent: 'w',
      permissions: ['project.read'],
      connectors: ['github'],
      env: [],
    });
  });

  test('grantFromLoadedAgents canonicalizes alias spellings (existing behavior)', () => {
    const loaded = extractAgents(
      v2('    connectors: [email]\n    kortix_permissions: [project.cr.open]\n'),
    );
    expect(loaded.errors).toEqual([]);
    expect(grantFromLoadedAgents('w', loaded)).toEqual({
      agent: 'w',
      permissions: ['project.gitops.push'],
      connectors: ['kortix_email'],
      env: [],
    });
  });
});

describe('governed grants canonicalize identically (the intended behavior change)', () => {
  test('resolveGovernedAgentGrant (subject) canonicalizes alias spellings', () => {
    const loaded = extractAgents(
      v2('    connectors: [email]\n    kortix_permissions: [project.cr.open]\n'),
    );
    expect(loaded.errors).toEqual([]);
    const governed = resolveGovernedAgentGrant('w', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    expect(governed.grant).toEqual({
      agent: 'w',
      permissions: ['project.gitops.push'],
      connectors: ['kortix_email'],
      env: [],
    });
  });
});

describe('declared agent grants and model', () => {
  test('parses an agent block\'s behavior and grants', () => {
    const manifest = parseManifestString(`default_agent: writer
agents:
  writer:
    model: test/model
    prompt: Be concise.
    connectors: [github]
    secrets: [KEY]
`, 'kortix.yaml');
    const loaded = extractAgents(manifest);
    expect(loaded.errors).toEqual([]);
    expect(loaded.defaultAgent).toBe('writer');
    expect(loaded.specs[0]?.model).toBe('test/model');
    expect(grantFromLoadedAgents('writer', loaded)).toMatchObject({ connectors: ['github'], env: ['KEY'] });
  });
});

describe('agentGrantAllowsRepository — repository bytes follow the agent grant', () => {
  test('only a grant holding project.gitops.read (any spelling) may receive the repository', () => {
    const cases: Array<[string, boolean]> = [
      ['    kortix_permissions: "*"\n', true],
      ['    kortix_permissions: [project.gitops.read]\n', true],
      ['    kortix_permissions: [workspace.gitops.read]\n', true],
      ['    kortix_permissions: [project.read]\n', false],
      ['    kortix_permissions: none\n', false],
      ['    prompt: hi\n', false],
    ];
    for (const [block, allowed] of cases) {
      const loaded = extractAgents(v2(block));
      expect(loaded.errors).toEqual([]);
      expect([block, agentGrantAllowsRepository('w', loaded)]).toEqual([block, allowed]);
      expect([block, agentGrantAllowsRepository(DEFAULT_AGENT_SENTINEL, loaded)]).toEqual([block, allowed]);
    }
  });

  test('an undeclared agent of a governed project gets nothing; a project without agents is unrestricted', () => {
    expect(agentGrantAllowsRepository('ghost', extractAgents(v2('    kortix_permissions: "*"\n')))).toBe(false);
    expect(agentGrantAllowsRepository('w', extractAgents(parseManifestString('project:\n  name: p\n', 'kortix.yaml')))).toBe(true);
  });
});
