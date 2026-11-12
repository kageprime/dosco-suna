/**
 * The agent editor on kortix.yaml. An agent keeps behavior and grants in
 * one YAML block and the prompt in `prompt` or `prompt_file`, so the
 * editor's wire shape (`block` + `block.behavior`) maps onto one block plus at
 * most one prompt file. Pure functions: the route does the git I/O.
 */
import { describe, expect, test } from 'bun:test';
import { validateManifest } from '@kortix/manifest-schema';
import {
  agentConfigViewV3,
  applyAgentBlockV2,
  applyAgentConfigV3,
  applyAgentScopeV2,
  applyDefaultAgentV2,
  grantSecretToAgentV2,
  readAgentBlockV2,
} from '../projects/lib/agent-config-v2';
import { parseManifestString, serializeManifest, synthesizeBlankManifest } from '../projects/triggers';

const V3 = `
default_agent: support
skills:
  triage: skills/triage
commands:
  report:
    prompt: Write the report.
extensions:
  audit:
    opencode: extensions/audit.ts
agents:
  support:
    description: Answers tickets.
    mode: primary
    model: kortix/glm-5.3-flash
    prompt_file: agents/support.md
    permission:
      bash: ask
    skills: [triage]
    subagents: [researcher]
    commands: [report]
    extensions: [audit]
    codemode: only
    connectors: [github]
    secrets: [STRIPE_KEY]
    kortix_permissions: [project.session.start]
    tools: all
  researcher:
    mode: subagent
    prompt: You research accounts.
    tools: all
`;

const manifest = () => parseManifestString(V3, 'kortix.yaml');
const block = (raw: Record<string, unknown>, name: string) =>
  (raw.agents as Record<string, Record<string, unknown>>)[name]!;

describe('readAgentBlockV2 on v3', () => {
  test('reads the declared block of a v3 agent', () => {
    const read = readAgentBlockV2(manifest(), 'support');

    expect(read).toMatchObject({ ok: true, defaultAgent: 'support' });
    if (!read.ok) return;
    expect(read.block).toMatchObject({ prompt_file: 'agents/support.md', subagents: ['researcher'] });
  });
});

describe('agentConfigViewV3', () => {
  test('splits a block into governance (with the v3 grants and file) and behavior (with the prompt file text)', () => {
    const view = agentConfigViewV3(block(manifest().raw, 'support'), 'Be kind.\n');

    expect(view.behavior).toEqual({
      description: 'Answers tickets.',
      mode: 'primary',
      model: 'kortix/glm-5.3-flash',
      permission: { bash: 'ask' },
      prompt: 'Be kind.\n',
    });
    expect(view.governance).toEqual({
      file: 'agents/support.md',
      skills: ['triage'],
      subagents: ['researcher'],
      commands: ['report'],
      extensions: ['audit'],
      codemode: 'only',
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      kortix_permissions: ['project.session.start'],
      tools: 'all',
    });
  });

  test('an inline prompt is the behavior prompt and no file is served', () => {
    const view = agentConfigViewV3(block(manifest().raw, 'researcher'), null);

    expect(view.behavior).toEqual({ mode: 'subagent', prompt: 'You research accounts.' });
    expect(view.governance.file).toBeUndefined();
  });

});

describe('applyAgentConfigV3', () => {
  test('writes behavior into the YAML block and the prompt into the existing prompt_file', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', {
      governance: { file: 'agents/support.md', skills: 'all', connectors: ['github'], secrets: ['STRIPE_KEY'] },
      behavior: { description: 'Answers tickets fast.', mode: 'primary', temperature: 0.2, prompt: 'Be brief.\n' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toEqual({ path: 'agents/support.md', content: 'Be brief.\n' });
    expect(block(applied.raw, 'support')).toEqual({
      description: 'Answers tickets fast.',
      mode: 'primary',
      temperature: 0.2,
      prompt_file: 'agents/support.md',
      skills: '*',
      // v3-only grants the body did not send are kept.
      subagents: ['researcher'],
      commands: ['report'],
      extensions: ['audit'],
      codemode: 'only',
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
    });
    expect(validateManifest(applied.raw).valid).toBe(true);
  });

  test('a governance-only edit keeps behavior, the prompt and the prompt file untouched', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', { governance: { connectors: 'all' } });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toBeNull();
    expect(block(applied.raw, 'support')).toMatchObject({
      description: 'Answers tickets.',
      model: 'kortix/glm-5.3-flash',
      prompt_file: 'agents/support.md',
      permission: { bash: 'ask' },
      // The wire's `all` is written as kortix.yaml's canonical "*".
      connectors: '*',
    });
    expect(block(applied.raw, 'support').secrets).toBeUndefined();
  });

  test('"every name" is `all` on the wire and "*" in the file; a value that already says it is kept', () => {
    const text = V3.replace('    connectors: [github]\n', '    connectors: "*"\n').replace('    permission:\n      bash: ask\n', '    permission:\n      bash: all\n');
    const starred = parseManifestString(text, 'kortix.yaml');
    const read = readAgentBlockV2(starred, 'support');
    if (!read.ok || !read.block) throw new Error('no block');
    const view = agentConfigViewV3(read.block, null);
    expect(view.governance).toMatchObject({ connectors: 'all', tools: 'all' });
    expect(view.behavior.permission).toEqual({ bash: 'allow' });
    // A GET → PUT round trip writes back what the file said, byte for byte.
    const applied = applyAgentConfigV3(starred, 'support', { governance: view.governance, behavior: view.behavior });
    if (!applied.ok) throw new Error(applied.error);
    expect(block(applied.raw, 'support')).toMatchObject({ connectors: '*', tools: 'all', permission: { bash: 'all' } });
    // A changed rule is written as sent.
    const changed = applyAgentConfigV3(starred, 'support', { governance: view.governance, behavior: { ...view.behavior, permission: { bash: 'deny' } } });
    if (!changed.ok) throw new Error(changed.error);
    expect(block(changed.raw, 'support').permission).toEqual({ bash: 'deny' });
  });

  test('an inline prompt stays inline', () => {
    const applied = applyAgentConfigV3(manifest(), 'researcher', {
      governance: {},
      behavior: { mode: 'subagent', prompt: 'You research accounts and cite sources.' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toBeNull();
    expect(block(applied.raw, 'researcher')).toEqual({ mode: 'subagent', prompt: 'You research accounts and cite sources.' });
  });

  test('a new agent with a prompt gets agents/<name>.md as its prompt file', () => {
    const applied = applyAgentConfigV3(manifest(), 'writer', {
      governance: { skills: ['triage'] },
      behavior: { mode: 'all', prompt: 'You write.\n' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toEqual({ path: 'agents/writer.md', content: 'You write.\n' });
    expect(block(applied.raw, 'writer')).toEqual({ mode: 'all', prompt_file: 'agents/writer.md', skills: ['triage'] });
  });

  test('clearing an inline prompt removes the key', () => {
    const applied = applyAgentConfigV3(manifest(), 'researcher', { governance: {}, behavior: { mode: 'subagent' } });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'researcher')).toEqual({ mode: 'subagent' });
  });

  test('a v3 grant sent as none clears it', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', {
      governance: { subagents: 'none', commands: 'none', extensions: 'none' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const next = block(applied.raw, 'support');
    expect(next.subagents).toBeUndefined();
    expect(next.commands).toBeUndefined();
    expect(next.extensions).toBeUndefined();
  });

  test('context: summary is written, record (the default) removes the key, and an omitted one is kept', () => {
    const off = applyAgentConfigV3(manifest(), 'support', { governance: { context: 'summary' } });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(block(off.raw, 'support').context).toBe('summary');

    const reparsed = parseManifestString(serializeManifest({ ...manifest(), raw: off.raw }), 'kortix.yaml');
    const kept = applyAgentConfigV3(reparsed, 'support', { governance: {} });
    if (!kept.ok) throw new Error(kept.error);
    expect(block(kept.raw, 'support').context).toBe('summary');

    const on = applyAgentConfigV3(reparsed, 'support', { governance: { context: 'record' } });
    if (!on.ok) throw new Error(on.error);
    expect(block(on.raw, 'support')).not.toHaveProperty('context');
  });

  test('a governance write that still sends repository_access or workspace writes neither key', () => {
    for (const governance of [{ repository_access: false }, { repository_access: true }, { workspace: { project_repository: true } }, { skills: 'all' }]) {
      const applied = applyAgentConfigV3(manifest(), 'researcher', { governance } as never);
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(block(applied.raw, 'researcher')).not.toHaveProperty('workspace');
      expect(block(applied.raw, 'researcher')).not.toHaveProperty('repository_access');
    }
  });

  test('refuses a different file than the current prompt_file', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', { governance: { file: 'agents/other.md' } });

    expect(applied).toMatchObject({ ok: false });
    if (applied.ok) return;
    expect(applied.error).toContain('agents/support.md');
  });

  test('a grant naming an unregistered thing is a validation error', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', { governance: { extensions: ['nope'] } });

    expect(applied).toMatchObject({ ok: false });
    if (applied.ok) return;
    expect(applied.error).toContain('agents.support.extensions');
  });

  test('a v2-only behavior key is refused', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', {
      governance: {},
      behavior: { permission: { skill: { '*': 'allow' } } },
    });

    expect(applied).toMatchObject({ ok: false });
  });
});

describe('the v2 writers accept a v3 manifest', () => {
  test('applyDefaultAgentV2 sets a v3 default agent', () => {
    expect(applyDefaultAgentV2(manifest(), 'support').ok).toBe(true);
  });

  test('applyAgentScopeV2 edits a v3 agent scope', () => {
    const applied = applyAgentScopeV2(manifest(), 'support', { env: 'all' });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'support')).toMatchObject({ secrets: '*', prompt_file: 'agents/support.md' });
  });

  test('grantSecretToAgentV2 grants a secret to a v3 agent (kortix secrets grant)', () => {
    const granted = grantSecretToAgentV2(manifest(), 'researcher', 'HELPDESK_TOKEN');

    expect(granted).toMatchObject({ ok: true, alreadyGranted: false });
    if (!granted.ok) return;
    expect(block(granted.raw, 'researcher')).toEqual({ mode: 'subagent', prompt: 'You research accounts.', tools: 'all', secrets: ['HELPDESK_TOKEN'] });
  });
});

describe('synthesizeBlankManifest', () => {
  test('a blank project reads as a valid manifest with the worker agent and no kortix_version', () => {
    const synthesized = synthesizeBlankManifest({ name: 'blank', manifestPath: null });

    expect(synthesized.raw).not.toHaveProperty('kortix_version');
    expect(validateManifest(synthesized.raw).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(serializeManifest(synthesized)).not.toContain('kortix_version');
    expect(block(synthesized.raw, 'worker')).toMatchObject({
      mode: 'primary',
      skills: '*',
      connectors: '*',
      secrets: '*',
      kortix_permissions: '*',
    });
    expect(serializeManifest(synthesized)).toContain('skills: "*"');
  });
});

describe('the shipped v3 starter compiles', () => {
  test('every agent compiles with its prompt file; the built-ins are off; the starter registers no extension', async () => {
    const { getStarterFiles } = await import('@kortix/starter');
    const { compileAgentConfig } = await import('../projects/lib/compile-agent-config');
    const files = Object.fromEntries(getStarterFiles({ projectName: 'Acme' }).map((file) => [file.path, file.content]));
    const raw = parseManifestString(files['kortix.yaml']!, 'kortix.yaml').raw;

    const compiled = compileAgentConfig(raw, files);

    expect(compiled.schema).toBe(3);
    expect(compiled.manifest_issues?.filter((issue) => issue.severity === 'error') ?? []).toEqual([]);
    // The starter's default is My Kortix, which is built in: the compiled set
    // holds only declared agents, and session create adds My Kortix.
    expect(raw.default_agent).toBe('mykortix');
    expect(compiled.default_agent).toBeUndefined();
    expect(compiled.agent.worker!.prompt?.trim()).toBeTruthy();
    expect(compiled.extensions ?? {}).toEqual({});
    for (const builtin of ['build', 'plan', 'general', 'explore']) expect(compiled.agent[builtin]).toEqual({ disable: true });
    expect(Object.keys(compiled.skills ?? {})).toContain('pdf');
  });
});

describe('the current workspace map survives the editor', () => {
  test('a read serves it and a write keeps it; only the legacy shapes are dropped', () => {
    const workspace = { repos: [{ path: '/workspace' }], setup: ['pnpm install'] };
    const applied = applyAgentConfigV3(manifest(), 'researcher', { governance: { workspace, skills: 'all' } } as never);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'researcher').workspace).toEqual(workspace);
    expect(agentConfigViewV3(block(applied.raw, 'researcher'), null).governance.workspace).toEqual(workspace);
    const legacy = applyAgentConfigV3(manifest(), 'researcher', { governance: { workspace: { project_repository: true } } } as never);
    expect(legacy.ok && block(legacy.raw, 'researcher')).not.toHaveProperty('workspace');
  });
});
