/**
 * The agent's `workspace: { repos, setup }`, prepared after the session starts. Real `git`
 * against a local bare repository standing in for the Git proxy, real `bash -lc` for setup.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWorkspaceSetup,
  renderWorkspaceSetupNote,
  runWorkspaceSetup,
  workspaceSetupStatus,
  type WorkspaceSetupSpec,
} from '@/harness/shared/workspace-setup'

let root: string
let origin: string
let workspace: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', ...args], { cwd, encoding: 'utf8' }).trim()

function spec(over: Omit<Partial<WorkspaceSetupSpec>, 'setup'> & { setup?: Array<string | { run: string; cwd?: string }> }): WorkspaceSetupSpec {
  const { setup = [], ...rest } = over
  return { version: 1, repos: [], ...rest, setup: setup.map((step) => (typeof step === 'string' ? { run: step } : step)) }
}

function options() {
  return {
    workspace,
    repoUrl: `file://${origin}`,
    branch: 'ses-synthetic-1',
    baseRef: 'main',
    statusPath: join(root, 'status.json'),
    logPath: join(root, 'setup.log'),
    notePath: join(root, 'note.md'),
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-workspace-setup-'))
  const seed = join(root, 'seed')
  mkdirSync(join(seed, 'apps', 'web'), { recursive: true })
  mkdirSync(join(seed, 'apps', 'api'), { recursive: true })
  writeFileSync(join(seed, 'README.md'), 'synthetic\n')
  writeFileSync(join(seed, 'apps', 'web', 'web.txt'), 'web\n')
  writeFileSync(join(seed, 'apps', 'api', 'api.txt'), 'api\n')
  git(root, 'init', '-q', '-b', 'main', seed)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'base')
  origin = join(root, 'origin.git')
  git(root, 'clone', '-q', '--bare', seed, origin)
  workspace = join(root, 'workspace')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('runWorkspaceSetup', () => {
  test('clones onto a new session branch from the base, then runs setup in the clone, and says so', async () => {
    const status = await runWorkspaceSetup(spec({ repos: [{ path: workspace }], setup: ['echo "$PWD" > setup-ran.txt'] }), options())

    expect(status.state).toBe('done')
    expect(status.steps.map((step) => [step.kind, step.state, step.exit_code])).toEqual([['clone', 'done', 0], ['run', 'done', 0]])
    expect(git(workspace, 'branch', '--show-current')).toBe('ses-synthetic-1')
    expect(git(workspace, 'config', 'push.default')).toBe('current')
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('synthetic\n')
    expect(readFileSync(join(workspace, 'setup-ran.txt'), 'utf8').trim()).toBe(workspace)
    // Progress the agent and /kortix/health can read; owner-only output.
    expect(JSON.parse(readFileSync(options().statusPath, 'utf8')).state).toBe('done')
    expect(workspaceSetupStatus()?.state).toBe('done')
    expect(statSync(options().logPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(options().notePath, 'utf8')).toContain('does not wait for you')
  })

  test('a session branch that already holds pushed work is checked out as it is, never reset', async () => {
    const work = join(root, 'pusher')
    git(root, 'clone', '-q', origin, work)
    git(work, 'checkout', '-q', '-b', 'ses-synthetic-1')
    git(work, 'commit', '-q', '--allow-empty', '-m', 'session work')
    git(work, 'push', '-q', 'origin', 'ses-synthetic-1')
    const tip = git(work, 'rev-parse', 'HEAD')

    const status = await runWorkspaceSetup(spec({ repos: [{ path: workspace }] }), options())

    expect(status.state).toBe('done')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(tip)
  })

  test('sparse keeps only the named folders of a monorepo, in a folder under /workspace', async () => {
    const target = join(workspace, 'web')
    const status = await runWorkspaceSetup(spec({ repos: [{ path: target, sparse: ['apps/web'] }] }), options())

    expect(status.state).toBe('done')
    expect(existsSync(join(target, 'apps', 'web', 'web.txt'))).toBe(true)
    expect(existsSync(join(target, 'apps', 'api', 'api.txt'))).toBe(false)
  })

  test('the first failure stops the rest; the status names the step and its exit code', async () => {
    const status = await runWorkspaceSetup(spec({ setup: ['exit 3', 'touch after.txt'] }), options())

    expect(status.state).toBe('failed')
    expect(status.steps.map((step) => [step.state, step.exit_code])).toEqual([['failed', 3], ['skipped', null]])
    expect(status.steps[0]!.error).toBe('exit 3')
    expect(existsSync(join(workspace, 'after.txt'))).toBe(false)
  })

  test('a resumed box on the same workspace runs nothing again; another spec runs', async () => {
    const counting = spec({ setup: ['echo run >> runs.txt'] })
    await runWorkspaceSetup(counting, options())
    const again = await runWorkspaceSetup(counting, options())
    expect(again.reused).toBe(true)
    expect(readFileSync(join(workspace, 'runs.txt'), 'utf8')).toBe('run\n')

    await runWorkspaceSetup(spec({ setup: ['echo run >> runs.txt', 'true'] }), options())
    expect(readFileSync(join(workspace, 'runs.txt'), 'utf8')).toBe('run\nrun\n')
  })

  test('a clone path outside the workspace fails that step and touches nothing there', async () => {
    const outside = join(root, 'elsewhere')
    const status = await runWorkspaceSetup(spec({ repos: [{ path: outside }] }), options())

    expect(status.state).toBe('failed')
    expect(status.steps[0]!.error).toContain('outside')
    expect(existsSync(outside)).toBe(false)
  })

  test('a step runs in its cwd: relative to the first clone, or absolute under /workspace', async () => {
    const status = await runWorkspaceSetup(
      spec({
        repos: [{ path: workspace }],
        setup: [{ run: 'pwd > here.txt', cwd: 'apps/web' }, { run: 'pwd > here.txt', cwd: join(workspace, 'apps', 'api') }, 'pwd > root.txt'],
      }),
      options(),
    )
    expect(status.state).toBe('done')
    expect(status.steps.map((step) => step.cwd ?? null)).toEqual([null, 'apps/web', join(workspace, 'apps', 'api'), null])
    expect(readFileSync(join(workspace, 'apps', 'web', 'here.txt'), 'utf8').trim()).toBe(join(workspace, 'apps', 'web'))
    expect(readFileSync(join(workspace, 'apps', 'api', 'here.txt'), 'utf8').trim()).toBe(join(workspace, 'apps', 'api'))
    expect(readFileSync(join(workspace, 'root.txt'), 'utf8').trim()).toBe(workspace)
  })

  test('each step is its own shell: a cd does not carry to the next step', async () => {
    mkdirSync(join(workspace, 'sub'))
    await runWorkspaceSetup(spec({ setup: ['cd sub && pwd > in-sub.txt', 'pwd > after.txt'] }), options())
    expect(readFileSync(join(workspace, 'sub', 'in-sub.txt'), 'utf8').trim()).toBe(join(workspace, 'sub'))
    expect(readFileSync(join(workspace, 'after.txt'), 'utf8').trim()).toBe(workspace)
  })

  test('a cwd outside the workspace, or one that does not exist, fails that step without running it', async () => {
    const outside = await runWorkspaceSetup(spec({ setup: [{ run: 'touch escaped.txt', cwd: '../..' }] }), options())
    expect(outside.state).toBe('failed')
    expect(outside.steps[0]!.error).toContain('outside')
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)

    const missing = await runWorkspaceSetup(spec({ setup: [{ run: 'true', cwd: 'nope' }] }), options())
    expect(missing.steps[0]!.error).toContain('does not exist')
  })

  test('it is a background task: the call returns at once with the setup running', async () => {
    const pending = runWorkspaceSetup(spec({ setup: ['sleep 1'] }), options())
    expect(workspaceSetupStatus()?.state).toBe('running')
    expect((await pending).state).toBe('done')
  })
})

describe('the spec and the prompt note', () => {
  const encode = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64')

  test('parses version 1, drops what is not a string, and ignores anything else', () => {
    expect(parseWorkspaceSetup(encode({ version: 1, repos: [{ path: '/workspace', sparse: ['apps/web', 7] }, { path: 1 }], setup: ['pnpm install', null, { run: 'pnpm build', cwd: 'apps/web' }, { cwd: 'x' }] }))).toEqual({
      version: 1,
      repos: [{ path: '/workspace', sparse: ['apps/web'] }],
      setup: [{ run: 'pnpm install' }, { run: 'pnpm build', cwd: 'apps/web' }],
    })
    expect(parseWorkspaceSetup(encode({ version: 2, setup: ['x'] }))).toBeNull()
    expect(parseWorkspaceSetup('not base64 json')).toBeNull()
    expect(parseWorkspaceSetup(undefined)).toBeNull()
  })

  test('the note lists each step, the reason a clone was withheld, and where progress is', () => {
    const note = renderWorkspaceSetupNote(spec({ repos: [{ path: '/workspace', sparse: ['apps/web'] }], setup: ['pnpm install', { run: 'pnpm build', cwd: 'apps/web' }], repos_skipped: 'no grant' }), '/s.json', '/s.log')
    expect(note).toContain('clone the workspace repository into `/workspace` on your session branch (only `apps/web`)')
    expect(note).toContain('run `pnpm install`')
    expect(note).toContain('run `pnpm build` in `apps/web`')
    expect(note).toContain('no clone: no grant')
    expect(note).toContain('`cat /s.json`')
  })
})
