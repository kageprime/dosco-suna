/**
 * Guards on the refresh path that are independent of config convergence:
 * a reboot must not reset an existing session branch, and `on_boot=1` requires
 * a direct service call.
 * Real Git repositories.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@/lib/config/config'
import type { HarnessControlOperations } from '@/harness/contract/control'
import { createPiConfigReleases } from '@/harness/pi/config-release'
import { createPiControlService } from '@/harness/pi/control'
import { KORTIX_SERVICE_CALL_HEADER } from '@/lib/kortix-api/kortix-user-context'
import { createRefreshRouter } from '@/routes/kortix/refresh'
import { commitAll, git as gitIn, initRepo, write as writeIn } from './helpers/config-release-fixtures'

let root: string
let work: string

const git = (cwd: string, ...args: string[]) => gitIn(cwd, ...args)
const write = (repo: string, rel: string, body: string) => writeIn(repo, rel, body)

function setup(_opts: { shallow: boolean }) {
  root = mkdtempSync(join(tmpdir(), 'kortix-refresh-guards-'))
  const origin = join(root, 'origin')
  work = join(root, 'work')
  initRepo(origin)
  write(origin, 'app.ts', 'export const x = 1\n')
  commitAll(origin, 'base')
  git(root, 'clone', '--quiet', `file://${origin}`, work)
  git(work, 'config', 'user.email', 't@t.co')
  git(work, 'config', 'user.name', 'T')
  git(work, 'checkout', '-q', '-b', 'ses-1111-2222')
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('on_boot=1 requires a DIRECT service call', () => {
  const TOKEN = 'service-key-under-test'

  function router(onBoot: () => void) {
    const cfg = { sandboxToken: TOKEN } as Config
    const control = {
      refresh: async () => ({ ok: true, repo: {}, runtime: 'ok', runtime_pid: 1 }),
    } as unknown as HarnessControlOperations
    return createRefreshRouter(cfg, control, { runSandboxOnBoot: onBoot })
  }

  test('a proxied request cannot launch the project boot command', async () => {
    let calls = 0
    const res = await router(() => calls++).request('/?on_boot=1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(403)
    expect(calls).toBe(0)
  })

  test('a direct service request launches the project boot command after refresh', async () => {
    let calls = 0
    const res = await router(() => calls++).request('/?repo=0&on_boot=1', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        [KORTIX_SERVICE_CALL_HEADER]: '1',
      },
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
    expect(await res.json()).toMatchObject({ on_boot: 'started' })
  })
})
