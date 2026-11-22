import { describe, expect, test } from 'bun:test';

import { PROD_TARGET, loopPrompt, sandboxHourlyUsd, setupGuide, setupHostName, setupPromptFor, setupTarget, templatePrompt } from './setup-guide';
import { CLOUD_HOST_NAME } from './host-config/config';

// A prompt copied on a deployment must name that deployment's guide, and the
// guide must point the CLI at that deployment's API (founder call 2026-11-10).
describe('setup target', () => {
  test('production, absent values and the production origin all give the production target', () => {
    expect(setupTarget(undefined, undefined)).toEqual(PROD_TARGET);
    expect(setupTarget('https://kortix.com/', 'https://api.kortix.com/v1')).toEqual(PROD_TARGET);
    // Production's APP_URL is https://www.kortix.com: its guide must be the production one.
    expect(setupTarget('https://www.kortix.com', 'https://api.kortix.com/v1')).toEqual(PROD_TARGET);
    expect(setupGuide(setupTarget('https://www.kortix.com', 'https://api.kortix.com/v1'))).not.toContain('not production');
  });

  test('dev, a local stack and a root-relative backend each point at themselves', () => {
    expect(setupTarget('https://dev.kortix.com', 'https://dev-api.kortix.com/v1')).toEqual({ origin: 'https://dev.kortix.com', apiBase: 'https://dev-api.kortix.com' });
    expect(setupTarget('http://localhost:14800', 'http://localhost:14808/v1')).toEqual({ origin: 'http://localhost:14800', apiBase: 'http://localhost:14808' });
    expect(setupTarget('https://kortix.example.com', '/v1')).toEqual({ origin: 'https://kortix.example.com', apiBase: 'https://kortix.example.com' });
  });

  test('prompts name the guide of their own deployment', () => {
    const local = setupTarget('http://localhost:14800', 'http://localhost:14808/v1');
    expect(setupPromptFor()).toContain('https://kortix.com/setup.md');
    expect(setupPromptFor(local)).toContain('http://localhost:14800/setup.md');
    expect(setupPromptFor(local)).not.toContain('kortix.com');
    expect(loopPrompt({ id: 'sales', name: 'Sales Factory' }, local)).toContain('http://localhost:14800/setup.md');
  });

  test('the guide off production installs from that origin and selects a CLI host for its API', () => {
    const dev = setupTarget('https://dev.kortix.com', 'https://dev-api.kortix.com/v1');
    const guide = setupGuide(dev);
    expect(setupHostName(dev)).toBe('dev-kortix-com');
    expect(guide).toContain('curl -fsSL https://dev.kortix.com/install | KORTIX_CHANNEL=dev bash');
    expect(guide).toContain('kortix hosts add dev-kortix-com --url https://dev-api.kortix.com');
    expect(guide).toContain('kortix hosts use dev-kortix-com');
    expect(setupGuide()).toContain('curl -fsSL https://kortix.com/install | bash');
    // An installed CLI can be older than the guide: the installer runs every time, never behind `command -v`.
    expect(guide).not.toContain('command -v kortix ||');
    expect(setupGuide()).not.toContain('command -v kortix ||');
    // Production selects the built-in cloud host: the CLI keeps the host an earlier guide chose.
    expect(setupGuide()).toContain(`kortix hosts use ${CLOUD_HOST_NAME}`);
    expect(setupGuide()).toContain(`kortix hosts current   # must print ${CLOUD_HOST_NAME}`);
    expect(setupGuide()).not.toContain('kortix hosts add');
    // The MCP server the guide registers is this deployment's own.
    expect(guide).toContain('claude mcp add --transport http kortix https://dev-api.kortix.com/v1/mcp');
    expect(setupGuide()).toContain('codex mcp add kortix --url https://api.kortix.com/v1/mcp');
  });
});

// The one prompt offers the templates; a template's prompt is the same guide
// with that template chosen (founder call 2026-11-16).
describe('templates in the setup guide', () => {
  test('the guide lists the templates, reads the recommended one, and asks for the template first', () => {
    const guide = setupGuide();
    expect(guide).toContain('kortix templates ls --json');
    expect(guide).toContain('kortix templates onboard <id> --steps');
    expect(guide).toContain('1. Template:');
    expect(guide).toContain('kortix templates add <id> --repo <owner/repo>');
    for (const name of ['Software Factory', 'Marketing Factory', 'Sales Factory', 'Recruiting Factory', 'Support Factory']) {
      expect(guide).toContain(name);
    }
  });

  test('a template prompt opens the setup guide with the template named, never a reference repository', () => {
    const prompt = loopPrompt({ id: 'software-factory', name: 'Software Factory' });
    expect(prompt).toContain('https://kortix.com/setup.md');
    expect(prompt).toContain('The template is software-factory.');
    expect(prompt).not.toContain('github.com');
    expect(templatePrompt({ id: 'sales', name: 'Sales Factory' })).toBe(loopPrompt({ id: 'sales', name: 'Sales Factory' }));
  });

  test('the person finishes on one setup page, not on links in the terminal', () => {
    const guide = setupGuide();
    expect(guide).toContain('kortix onboard --yes --json --wait');
    expect(guide).toContain('<web>/workspaces/<id>/setup');
    expect(guide).toContain('Never print those links in the terminal.');
    expect(guide).not.toContain('give the person\nall of them in one message');
  });

  test('the guide offers Slack and declares it with the slug Kortix writes when Slack connects', () => {
    const guide = setupGuide();
    expect(guide).toContain('5. Slack, unless the plan shows it connected. Recommend yes');
    // apps/api/src/connectors/channel-manifest.ts writes this entry on connect: the same slug makes that a no-op.
    expect(guide).toContain('  - slug: kortix_slack\n    name: Slack\n    provider: channel\n    platform: slack');
    expect(guide).toContain('--channels\` takes the Slack channels the reply named');
  });

  test('the guide lets the person keep Kortix in their repository, reuses its skills, and proves the dev environment', () => {
    const guide = setupGuide();
    // Where Kortix lives: this repository for one repository or a monorepo, a new one for several.
    expect(guide).toContain('a) this repository (recommended for one repository or a monorepo)');
    expect(guide).toContain('b) a new repository Kortix hosts (recommended for a product over');
    expect(guide).toContain('skills: { <name>: .claude/skills/<name> }');
    expect(guide).toContain('agents.<name>.prompt_file: .claude/agents/<name>.md');
    // Every app found, not only the ones a loop calls.
    expect(guide).toContain('whether a loop calls it or not');
    expect(guide).toContain('"Anything missing?"');
    // The dev environment runs for real on the workspace image, judged from the tool output.
    expect(guide).toContain('kortix sessions new --agent <agent> --json --prompt');
    expect(guide).toContain('kortix sessions wait-for <session_id> --timeout 1800 --json');
    expect(guide).toContain('kortix sessions log <session_id> --json --limit 200');
    expect(guide).toContain('never from the agent\'s summary');
    // The person makes every sign-in on the setup page; the agent never clicks or signs in for them.
    expect(guide).toContain('Never sign in, connect or click for the person');
    expect(guide).not.toContain('providers login claude');
    expect(guide).not.toContain('--connect <slug');
    expect(guide).not.toContain('rule 10), makes');
  });

  test('the guide sizes the sandbox from the stack, quotes its cost, and resizes from measured peaks', () => {
    const guide = setupGuide();
    expect(guide).toContain('8. **What it needs to run.**');
    expect(guide).toContain('(cpu 1–32, memory 1–128, disk 1–500)');
    expect(sandboxHourlyUsd(4, 8)).toBe(0.22);
    expect(guide).toContain('about $0.22 an hour while a session runs');
    expect(guide).toContain('sample used memory and used disk every 2');
    expect(guide).toContain('peak memory above 80 % of the size: one step up');
    expect(guide).toContain('kortix sandboxes update <slug> --cpu <n> --memory <gb> --disk');
    expect(guide).toContain('Never go under 2 vCPU, 4 GB and 20 GB');
  });

  test('the guide uses none of the words its plain-words rule bans, outside that rule', () => {
    const guide = setupGuide();
    const rule = guide.slice(guide.indexOf('6. **Plain words.**'), guide.indexOf('7. **Be brief.**'));
    expect(rule.length).toBeGreaterThan(100);
    const rest = guide.replace(rule, '');
    const banned = /\b(seamless(ly)?|robust|leverag\w*|powerful|unlock\w*|empower\w*|streamlin\w*|supercharg\w*|effortless\w*|magic\w*|game-changer|dive in|let's|I'd be happy to|great|simply|just|exciting|24\/7)\b/gi;
    expect(rest.match(banned) ?? []).toEqual([]);
  });
});
