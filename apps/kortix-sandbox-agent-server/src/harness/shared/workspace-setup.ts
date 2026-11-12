import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { logger } from '@/lib/log/logger'

/**
 * An agent's `workspace: { repos, setup }` (kortix.yaml), prepared in the BACKGROUND after
 * the session starts. Nothing here holds the runtime, the first turn or readiness: boot
 * starts it detached and moves on. The API sends the spec as `KORTIX_WORKSPACE_SETUP`
 * (apps/api/src/projects/lib/session-runtime-env.ts).
 *
 * Steps run in order: each clone (onto the session branch, the one branch the Git proxy
 * lets a session push), then each setup command in a login shell, so it gets the agent's
 * secrets the same way the agent's own shell does. The first failure stops the rest; the
 * session keeps running. Progress is a JSON status file and `/kortix/health`
 * `workspace_setup`; output goes to one owner-only log. A box that resumes on its volume
 * finds the done marker for the same spec in `/workspace/.kortix` and runs nothing again.
 */

export const WORKSPACE_SETUP_STATUS_PATH = process.env.KORTIX_WORKSPACE_SETUP_STATUS_PATH || '/tmp/kortix/workspace-setup.json'
export const WORKSPACE_SETUP_LOG_PATH = process.env.KORTIX_WORKSPACE_SETUP_LOG_PATH || '/tmp/kortix/workspace-setup.log'
/** Appended to the agent's system prompt (harness/pi/runtime.ts), like the secret capabilities file. */
export const WORKSPACE_SETUP_NOTE_PATH = process.env.KORTIX_WORKSPACE_SETUP_NOTE_PATH || '/tmp/kortix/workspace-setup.md'
const DONE_MARKER = '.kortix/workspace-setup.done.json'
const STEP_TIMEOUT_MS = Number(process.env.KORTIX_WORKSPACE_SETUP_STEP_TIMEOUT_MS) || 30 * 60_000

export interface WorkspaceSetupStepSpec {
  run: string
  /** Relative to the first clone's folder (or the workspace), or absolute under the workspace. */
  cwd?: string
}

export interface WorkspaceSetupSpec {
  version: 1
  repos: Array<{ path: string; sparse?: string[] }>
  setup: WorkspaceSetupStepSpec[]
  /** Why the API withheld the clones (no repository access). */
  repos_skipped?: string
}

export type WorkspaceSetupStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface WorkspaceSetupStep {
  kind: 'clone' | 'run'
  label: string
  /** A `run` step's folder, as declared. */
  cwd?: string
  state: WorkspaceSetupStepState
  exit_code: number | null
  started_at: string | null
  ended_at: string | null
  error?: string
}

export interface WorkspaceSetupStatus {
  state: 'running' | 'done' | 'failed'
  started_at: string
  ended_at: string | null
  steps: WorkspaceSetupStep[]
  log: string
  repos_skipped?: string
  /** A resumed box found this spec already done and ran nothing. */
  reused?: boolean
}

/** Runs one command; resolves its exit code (124 on timeout, 127 when it cannot start). Output goes to `logFd`. */
export type RunCommand = (argv: string[], options: { cwd: string; logFd: number; timeoutMs: number }) => Promise<number>

export interface WorkspaceSetupOptions {
  /** The session's folder, `/workspace`: every clone path must be it or under it. */
  workspace: string
  /** The Git proxy URL of the workspace repository (`KORTIX_REPO_URL`). */
  repoUrl?: string
  /** The session branch (`KORTIX_BRANCH_NAME`). */
  branch?: string
  /** The base branch a new session branch starts from (`KORTIX_DEFAULT_BRANCH`). */
  baseRef: string
  statusPath?: string
  logPath?: string
  notePath?: string
  run?: RunCommand
  now?: () => Date
}

let current: WorkspaceSetupStatus | null = null

/** This box's setup, for `/kortix/health`. Null when the agent declares none. */
export function workspaceSetupStatus(): WorkspaceSetupStatus | null {
  return current
}

/** `KORTIX_WORKSPACE_SETUP` (base64 JSON, version 1), or null when absent or unreadable. */
export function parseWorkspaceSetup(raw: string | undefined): WorkspaceSetupSpec | null {
  if (!raw?.trim()) return null
  try {
    const body = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Partial<WorkspaceSetupSpec>
    if (body.version !== 1) return null
    const repos = (Array.isArray(body.repos) ? body.repos : []).flatMap((repo) =>
      repo && typeof repo.path === 'string' && repo.path.trim()
        ? [{ path: repo.path.trim(), ...(Array.isArray(repo.sparse) && repo.sparse.length ? { sparse: repo.sparse.filter((dir) => typeof dir === 'string' && dir.trim()) } : {}) }]
        : [],
    )
    const setup = (Array.isArray(body.setup) ? (body.setup as unknown[]) : []).flatMap((step): WorkspaceSetupStepSpec[] => {
      if (typeof step === 'string') return step.trim() ? [{ run: step }] : []
      if (!step || typeof step !== 'object') return []
      const { run, cwd } = step as { run?: unknown; cwd?: unknown }
      if (typeof run !== 'string' || !run.trim()) return []
      return [{ run, ...(typeof cwd === 'string' && cwd.trim() ? { cwd: cwd.trim() } : {}) }]
    })
    if (!repos.length && !setup.length && !body.repos_skipped) return null
    return { version: 1, repos, setup, ...(typeof body.repos_skipped === 'string' ? { repos_skipped: body.repos_skipped } : {}) }
  } catch {
    return null
  }
}

/** The prompt section: the agent learns the workspace is still being prepared, and where to look. */
export function renderWorkspaceSetupNote(spec: WorkspaceSetupSpec, statusPath = WORKSPACE_SETUP_STATUS_PATH, logPath = WORKSPACE_SETUP_LOG_PATH): string {
  const lines = ['## Workspace setup', '', 'This workspace is prepared in the background; it does not wait for you, and you need not wait for it:']
  for (const repo of spec.repos) lines.push(`- clone the workspace repository into \`${repo.path}\` on your session branch${repo.sparse?.length ? ` (only ${repo.sparse.map((dir) => `\`${dir}\``).join(', ')})` : ''}`)
  for (const step of spec.setup) lines.push(`- run \`${step.run}\`${step.cwd ? ` in \`${step.cwd}\`` : ''}`)
  if (spec.repos_skipped) lines.push(`- no clone: ${spec.repos_skipped}`)
  lines.push('', `Progress: \`cat ${statusPath}\` (\`state\`: running, done or failed). Output: \`${logPath}\`.`)
  lines.push('Files it creates may be missing until it is done. If it failed, read the log and run the step yourself.')
  return lines.join('\n')
}

export function workspaceSetupHash(spec: WorkspaceSetupSpec): string {
  return createHash('sha256').update(JSON.stringify({ repos: spec.repos, setup: spec.setup })).digest('hex')
}

/** A step's folder: `cwd` relative to `base`, or absolute; null when it leaves the workspace. */
function stepDir(workspace: string, base: string, cwd: string | undefined): string | null {
  if (!cwd) return base
  return cloneTarget(workspace, cwd.startsWith('/') ? cwd : resolve(base, cwd))
}

/** The clone target inside the workspace, or null when the path leaves it. */
function cloneTarget(workspace: string, path: string): string | null {
  const root = resolve(workspace)
  const target = resolve(path)
  return target === root || target.startsWith(`${root}/`) ? target : null
}

const defaultRun: RunCommand = (argv, { cwd, logFd, timeoutMs }) =>
  new Promise((done) => {
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(code)
    }
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: process.env, stdio: ['ignore', logFd, logFd] })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(124)
    }, timeoutMs)
    child.on('error', () => finish(127))
    child.on('exit', (code, signal) => finish(code ?? (signal ? 128 : 1)))
  })

function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Prepare the workspace. Resolves the final status; never throws (a failure is a `failed`
 * step). Callers start it detached: `void runWorkspaceSetup(…)`.
 */
export async function runWorkspaceSetup(spec: WorkspaceSetupSpec, options: WorkspaceSetupOptions): Promise<WorkspaceSetupStatus> {
  const statusPath = options.statusPath ?? WORKSPACE_SETUP_STATUS_PATH
  const logPath = options.logPath ?? WORKSPACE_SETUP_LOG_PATH
  const notePath = options.notePath ?? WORKSPACE_SETUP_NOTE_PATH
  const run = options.run ?? defaultRun
  const now = () => (options.now ?? (() => new Date()))().toISOString()
  const status: WorkspaceSetupStatus = {
    state: 'running',
    started_at: now(),
    ended_at: null,
    log: logPath,
    steps: [
      ...spec.repos.map((repo): WorkspaceSetupStep => ({ kind: 'clone', label: repo.path, state: 'pending', exit_code: null, started_at: null, ended_at: null })),
      ...spec.setup.map((step): WorkspaceSetupStep => ({ kind: 'run', label: step.run, ...(step.cwd ? { cwd: step.cwd } : {}), state: 'pending', exit_code: null, started_at: null, ended_at: null })),
    ],
    ...(spec.repos_skipped ? { repos_skipped: spec.repos_skipped } : {}),
  }
  current = status
  const save = () => {
    try {
      writeAtomic(statusPath, `${JSON.stringify(status, null, 2)}\n`)
    } catch (err) {
      logger.warn('[workspace-setup] status write failed', { err: (err as Error).message })
    }
  }
  try {
    writeAtomic(notePath, `${renderWorkspaceSetupNote(spec, statusPath, logPath)}\n`)
  } catch (err) {
    logger.warn('[workspace-setup] prompt note write failed', { err: (err as Error).message })
  }

  const marker = join(options.workspace, DONE_MARKER)
  const hash = workspaceSetupHash(spec)
  try {
    if ((JSON.parse(readFileSync(marker, 'utf8')) as { hash?: string }).hash === hash) {
      for (const step of status.steps) step.state = 'done'
      Object.assign(status, { state: 'done', ended_at: now(), reused: true })
      save()
      logger.info('[workspace-setup] already done on this workspace; nothing runs', { steps: status.steps.length })
      return status
    }
  } catch {
    // No marker, or another spec: run.
  }
  save()

  let logFd: number
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    logFd = openSync(logPath, 'a', 0o600)
    // Owner-only: setup output can carry secrets. The daemon and the agent both run as kortix.
    fchmodSync(logFd, 0o600)
  } catch (err) {
    Object.assign(status, { state: 'failed', ended_at: now() })
    status.steps[0] && Object.assign(status.steps[0], { state: 'failed', error: `cannot open the log: ${(err as Error).message}` })
    save()
    return status
  }

  const header = (text: string) => writeFileSync(logFd, `\n=== ${now()} ${text}\n`)
  const firstRepo = spec.repos[0] ? cloneTarget(options.workspace, spec.repos[0].path) : null
  const runDir = firstRepo ?? options.workspace
  try {
    for (const [index, step] of status.steps.entries()) {
      Object.assign(step, { state: 'running', started_at: now() })
      save()
      let code: number
      let error: string | undefined
      if (step.kind === 'clone') {
        const repo = spec.repos[index]!
        header(`clone into ${repo.path}`)
        ;({ code, error } = await cloneRepo(repo, options, { run, logFd }))
      } else {
        const dir = stepDir(options.workspace, runDir, step.cwd)
        header(`run ${step.label}${step.cwd ? ` in ${step.cwd}` : ''}`)
        if (!dir) {
          code = 2
          error = `cwd ${step.cwd} is outside ${options.workspace}`
        } else if (!existsSync(dir)) {
          code = 2
          error = `cwd ${step.cwd} does not exist`
        } else {
          code = await run(['bash', '-lc', step.label], { cwd: dir, logFd, timeoutMs: STEP_TIMEOUT_MS })
          if (code === 124) error = `timed out after ${Math.round(STEP_TIMEOUT_MS / 60_000)} min`
        }
      }
      Object.assign(step, { state: code === 0 ? 'done' : 'failed', exit_code: code, ended_at: now(), ...(code !== 0 ? { error: error ?? `exit ${code}` } : {}) })
      if (code !== 0) {
        for (const rest of status.steps.slice(index + 1)) rest.state = 'skipped'
        Object.assign(status, { state: 'failed', ended_at: now() })
        save()
        logger.warn('[workspace-setup] a step failed; the session keeps running', { step: step.label, code })
        return status
      }
      save()
    }
    Object.assign(status, { state: 'done', ended_at: now() })
    save()
    try {
      writeAtomic(marker, `${JSON.stringify({ hash, done_at: status.ended_at })}\n`)
    } catch (err) {
      logger.warn('[workspace-setup] done marker write failed; a resume runs it again', { err: (err as Error).message })
    }
    logger.info('[workspace-setup] done', { steps: status.steps.length })
    return status
  } finally {
    closeSync(logFd)
  }
}

/**
 * One clone, onto the session branch. Works into an empty folder and into one the agent or
 * the image already put files in (`git init` + fetch + checkout, never `git clone` into a
 * non-empty directory). A folder that already holds a repository is left as it is.
 */
async function cloneRepo(
  repo: { path: string; sparse?: string[] },
  options: WorkspaceSetupOptions,
  io: { run: RunCommand; logFd: number },
): Promise<{ code: number; error?: string }> {
  const target = cloneTarget(options.workspace, repo.path)
  if (!target) return { code: 2, error: `${repo.path} is outside ${options.workspace}` }
  if (!options.repoUrl) return { code: 2, error: 'this box has no KORTIX_REPO_URL' }
  if (existsSync(join(target, '.git'))) {
    writeFileSync(io.logFd, `${target} already holds a repository; left as it is.\n`)
    return { code: 0 }
  }
  mkdirSync(target, { recursive: true })
  const git = (...args: string[]) => io.run(['git', '-C', target, ...args], { cwd: target, logFd: io.logFd, timeoutMs: STEP_TIMEOUT_MS })
  const steps: string[][] = [
    ['init', '-q'],
    ['remote', 'add', 'origin', options.repoUrl],
    ...(repo.sparse?.length ? [['config', 'core.sparseCheckout', 'true'], ['sparse-checkout', 'set', '--cone', ...repo.sparse]] : []),
    ['fetch', '-q', ...(repo.sparse?.length ? ['--filter=blob:none'] : []), 'origin'],
  ]
  for (const args of steps) {
    const code = await git(...args)
    if (code !== 0) return { code, error: `git ${args[0]} failed (exit ${code})` }
  }
  const branch = options.branch?.trim()
  // The session branch when it already holds pushed work (never reset), else a new one from the base.
  const existing = branch ? (await git('rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`)) === 0 : false
  const checkout = branch
    ? ['checkout', '-q', '-B', branch, existing ? `origin/${branch}` : `origin/${options.baseRef}`]
    : ['checkout', '-q', '-B', options.baseRef, `origin/${options.baseRef}`]
  const code = await git(...checkout)
  if (code !== 0) return { code, error: `git checkout failed (exit ${code})` }
  await git('config', 'push.default', 'current')
  return { code: 0 }
}

