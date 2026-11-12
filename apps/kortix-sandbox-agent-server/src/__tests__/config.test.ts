/**
 * The daemon's environment contract (`src/lib/config/config.ts`): what each `KORTIX_*`
 * variable the API sets turns into, and the defaults a box boots with when it
 * is absent. One table, so a changed default or a dropped mapping fails one
 * named row.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSandboxOnBoot } from '@/lib/config/config'
import { loadConfig } from '@/harness/harness'

const BASE_ENV = { KORTIX_WORKSPACE: '/workspace', KORTIX_REPO_URL: 'https://example.test/r.git' }

describe('loadConfig env contract', () => {
  test.each([
    ['the sandbox credential comes from KORTIX_TOKEN', { KORTIX_TOKEN: 'sandbox-token' }, { sandboxToken: 'sandbox-token' }],
    ['the repository the agent may clone comes from KORTIX_REPO_URL', {}, { repoUrl: 'https://example.test/r.git' }],
    ['/workspace is the box disk by default', {}, { workspaceVolume: false }],
    ['KORTIX_WORKSPACE_VOLUME=1 says /workspace is a volume', { KORTIX_WORKSPACE_VOLUME: '1' }, { workspaceVolume: true }],
  ] as const)('%s', (_name, env, expected) => {
    expect(loadConfig({ ...BASE_ENV, ...env } as NodeJS.ProcessEnv)).toMatchObject(expected)
  })

  // The box never clones at boot: no clone setting reaches the config, whatever an older API sends.
  test('clone-at-boot variables an older API may send leave no trace in the config', () => {
    const config = loadConfig({
      ...BASE_ENV,
      KORTIX_PROJECT_AUTO_CLONE: '1',
      KORTIX_CLONE_DEPTH: '0',
      KORTIX_SESSION_BRANCH_RESTORE: '1',
      KORTIX_GIT_DELTA_BUNDLE_BASE64: 'R0lUIEJVTkRMRQ==',
    } as NodeJS.ProcessEnv) as Record<string, unknown>
    for (const key of ['autoClone', 'cloneDepth', 'cloneFilter', 'sessionBranchRestore', 'gitDeltaBundleBase64']) {
      expect([key, config[key]]).toEqual([key, undefined])
    }
  })
})

describe('resolveSandboxOnBoot', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kortix-on-boot-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  const onBoot = () =>
    resolveSandboxOnBoot(loadConfig({ KORTIX_WORKSPACE: workspace, KORTIX_PROJECT_TARGET: workspace } as NodeJS.ProcessEnv))

  test.each([
    ['kortix.yaml', 'sandbox:\n  on_boot: "pnpm dev"\n', 'pnpm dev'],
    ['kortix.yaml', 'sandbox:\n  on_boot: pnpm dev\n', 'pnpm dev'],
    ['kortix.yaml', 'sandbox:\n  on_boot: |\n    mkdir -p /mnt/data\n    printf ready > /mnt/data/status\n', 'mkdir -p /mnt/data\nprintf ready > /mnt/data/status'],
    ['kortix.yml', 'sandbox:\n  on_boot: pnpm dev\n', 'pnpm dev'],
    // TOML is not a manifest format: a kortix.toml is not read.
    ['kortix.toml', '[sandbox]\non_boot = "pnpm dev"\n', null],
    ['kortix.yaml', 'sandbox:\n  cpu: 4\n', null],
  ])('%s %j → %j', async (file, body, expected) => {
    writeFileSync(join(workspace, file), body)
    expect(await onBoot()).toBe(expected)
  })

  test('no manifest → null', async () => {
    expect(await onBoot()).toBeNull()
  })
})
