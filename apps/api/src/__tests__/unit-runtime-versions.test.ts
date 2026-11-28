import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_BROWSER_VERSION,
  ANYDOC_VERSION,
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  BUN_VERSION,
  OPENCODE_USER_AGENT,
  PLAYWRIGHT_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
} from '@kortix/shared';
import { CODEX_USER_AGENT } from '../llm-gateway/credentials/codex-core';
import {
  AGENT_BROWSER_PLUGIN_CONFIG_B64,
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  buildLayeredDockerfile,
} from '../snapshots/dockerfile-layer';

const repoRoot = resolve(import.meta.dir, '../../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('runtime version drift guards', () => {
  test('no package depends on the OpenCode SDK', () => {
    // @kortix/sdk owns its types (kortix.transcript.v1); no runtime is OpenCode.
    for (const path of ['packages/sdk/package.json', 'apps/api/package.json']) {
      const pkg = JSON.parse(readRepoFile(path)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.['@opencode-ai/sdk']).toBeUndefined();
      expect(pkg.devDependencies?.['@opencode-ai/sdk']).toBeUndefined();
    }
  });

  test('sandbox Dockerfile reads runtime pins from the shared manifest', () => {
    const dockerfile = readRepoFile('apps/sandbox/Dockerfile');
    expect(dockerfile).toContain('COPY packages/shared/src/runtime-versions.json');
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').agentBrowser");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').playwright");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').bun");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').anydoc");
    expect(dockerfile).toContain('pnpmSha256Amd64');
    expect(dockerfile).toContain('pnpmSha256Arm64');
    expect(dockerfile).toContain('uvSha256Amd64');
    expect(dockerfile).toContain('uvSha256Arm64');
    expect(dockerfile).toContain('bunSha256Amd64');
    expect(dockerfile).toContain('bunSha256Arm64');
    expect(
      dockerfile.match(
        /FROM oven\/bun:1\.4\.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e/g,
      ),
    ).toHaveLength(2);
    expect(dockerfile).not.toContain('FROM oven/bun:1-debian');
    expect(dockerfile).not.toContain('get.pnpm.io/install.sh');
    expect(dockerfile).not.toContain('curl -LsSf "https://astral.sh/uv/');
    expect(dockerfile).not.toContain('https://bun.com/install');
    expect(dockerfile).not.toMatch(/ARG OPENCODE_VERSION=/);
    expect(dockerfile).not.toMatch(/ARG AGENT_BROWSER_VERSION=/);
    expect(dockerfile).not.toMatch(/ARG PLAYWRIGHT_VERSION=/);
  });

  // Website logins reach a page only through the `kortix` agent-browser
  // credential plugin. Both images must configure it identically and keep the
  // daemon from closing an idle browser (agent-browser 0.32+ default: 1 h).
  test('both sandbox images configure the kortix credential plugin', () => {
    const config = JSON.parse(atob(AGENT_BROWSER_PLUGIN_CONFIG_B64));
    expect(config.plugins).toEqual([
      { name: 'kortix', command: '/usr/local/bin/kortix', args: ['secrets', 'browser-plugin'], capabilities: ['credential.read'] },
    ]);
    const merged = buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      machineDocPath: 'MACHINE.md',
      slackCliPath: 'kortix-slack-cli',
      managedSkillsPath: 'managed-skills',
    });
    for (const dockerfile of [merged, readRepoFile('apps/sandbox/Dockerfile')]) {
      expect(dockerfile).toContain(
        `RUN printf %s ${AGENT_BROWSER_PLUGIN_CONFIG_B64} | base64 -d > /home/kortix/.agent-browser/config.json`,
      );
      expect(dockerfile).toContain('agent-browser plugin list 2>&1 | grep -q kortix');
      expect(dockerfile).toContain('AGENT_BROWSER_IDLE_TIMEOUT_MS=0');
      expect(dockerfile).toContain('AGENT_BROWSER_NO_VERSION_CHECK=1');
    }
  });

  test('generated snapshot Dockerfile uses canonical runtime pins', () => {
    const merged = buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      machineDocPath: 'MACHINE.md',
      slackCliPath: 'kortix-slack-cli',
      managedSkillsPath: 'managed-skills',
    });

    expect(merged).toContain(`agent-browser@${AGENT_BROWSER_VERSION}`);
    expect(merged).toContain(`@firecrawl/anydoc@${ANYDOC_VERSION}`);
    expect(merged).toContain(`playwright@${PLAYWRIGHT_VERSION} install --with-deps --no-shell chromium`);
    expect(merged).toContain(BUN_VERSION);
    for (const digest of [
      PNPM_SHA256_AMD64,
      PNPM_SHA256_ARM64,
      UV_SHA256_AMD64,
      UV_SHA256_ARM64,
      BUN_SHA256_AMD64,
      BUN_SHA256_ARM64,
    ]) {
      expect(merged).toContain(digest);
    }
  });

  test('Codex/OpenAI OAuth traffic presents the same OpenCode user-agent pin', () => {
    expect(CODEX_USER_AGENT).toBe(OPENCODE_USER_AGENT);
  });
});
