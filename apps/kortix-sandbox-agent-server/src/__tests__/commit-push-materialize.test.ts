/**
 * The host-driven commit-push materializes the repository on demand.
 *
 * Since #12136 a session boots with an empty /workspace (no checkout at boot),
 * so `commitAndPushWorkingTree` found no repository and answered 409
 * "project repo is not materialized". When the session holds KORTIX_REPO_URL
 * — the same repository-access grant the agent's own `kortix workspaces
 * clone` needs — the daemon now materializes the repo in place: `git init`,
 * origin → the managed remote, fetch the remote default tip, check the
 * session branch out from it while keeping the agent's untracked files, then
 * the ordinary commit + push runs. A session with no repository connected
 * still refuses.
 *
 * Real `git` against real bare `file://`-free local remotes, no mocks.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import { commitAndPushWorkingTree, readRepoInfo } from '@/lib/git/git'
import { testConfig } from './helpers/daemon-test-app'

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Kortix Test',
      GIT_AUTHOR_EMAIL: 'test@kortix.dev',
      GIT_COMMITTER_NAME: 'Kortix Test',
      GIT_COMMITTER_EMAIL: 'test@kortix.dev',
    },
  }).trim()
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A bare origin whose `main` carries one base commit, and an unmaterialized target holding agent work. */
function workspaceWithUnmaterializedTarget(): { remote: string; target: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), 'kortix-commit-push-materialize-'))
  tempDirs.push(root)
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const target = join(root, 'workspace')
  git(['init', '--bare', remote])
  mkdirSync(seed)
  git(['init', '-b', 'main'], seed)
  writeFileSync(join(seed, 'README.md'), 'base\n')
  git(['add', 'README.md'], seed)
  git(['commit', '-m', 'base'], seed)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', 'origin', 'main'], seed)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  const baseSha = git(['-C', seed, 'rev-parse', 'HEAD'])
  // The session booted with an empty /workspace (#12136) and the agent wrote
  // files: untracked work, no .git.
  mkdirSync(target)
  writeFileSync(join(target, 'agent-notes.md'), 'agent work\n')
  return { remote, target, baseSha }
}

describe('commitAndPushWorkingTree materializes on demand', () => {
  it('materializes the repo, commits the agent work and pushes the session branch', async () => {
    const { remote, target, baseSha } = workspaceWithUnmaterializedTarget()
    const cfg = testConfig({
      projectTarget: target,
      repoUrl: remote,
      defaultBranch: 'main',
      branchName: 'session-abc',
    })

    const result = await commitAndPushWorkingTree(cfg, { message: 'agent work' })

    expect(result).toMatchObject({ committed: true, pushed: true, nothingToDo: false, branch: 'session-abc' })
    // The session branch starts at the remote default tip.
    expect(git(['rev-parse', `session-abc^`], target)).toBe(baseSha)
    // The push landed on origin.
    const pushedSha = git(['rev-parse', 'HEAD'], target)
    expect(git(['ls-remote', remote, 'refs/heads/session-abc'])).toContain(pushedSha)
    // The pushed tree carries BOTH the base content and the agent's file.
    expect(git(['ls-tree', '--name-only', 'refs/heads/session-abc'], remote).split('\n'))
      .toEqual(expect.arrayContaining(['README.md', 'agent-notes.md']))
    expect(git(['show', 'refs/heads/session-abc:agent-notes.md'], remote)).toBe('agent work')
    // Nothing the session wrote is deleted, and the base content materialized around it.
    expect(readFileSync(join(target, 'agent-notes.md'), 'utf8')).toBe('agent work\n')
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('base\n')
  })

  it('is idempotent: the second call is a no-op', async () => {
    const { remote, target } = workspaceWithUnmaterializedTarget()
    const cfg = testConfig({
      projectTarget: target,
      repoUrl: remote,
      defaultBranch: 'main',
      branchName: 'session-abc',
    })
    await commitAndPushWorkingTree(cfg, { message: 'agent work' })
    const headSha = git(['rev-parse', 'HEAD'], target)

    const second = await commitAndPushWorkingTree(cfg, { message: 'agent work' })

    expect(second).toMatchObject({ committed: false, pushed: false, nothingToDo: true, headSha })
    expect(git(['ls-remote', remote, 'refs/heads/session-abc'])).toContain(headSha)
  })

  it('resumes from the remote session branch tip when the branch was already pushed', async () => {
    // A replacement box (stop → start) boots with an empty /workspace again;
    // the session branch on origin carries the earlier work. The materialize
    // must start at THAT tip, or the push is rejected as non-fast-forward.
    const { remote, target, baseSha } = workspaceWithUnmaterializedTarget()
    const cfg = testConfig({
      projectTarget: target,
      repoUrl: remote,
      defaultBranch: 'main',
      branchName: 'session-abc',
    })
    // Materialize + push once, then reset the target to what a replacement
    // box's /workspace looks like: empty except the new agent work (no .git).
    await commitAndPushWorkingTree(cfg, { message: 'agent work' })
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target)
    writeFileSync(join(target, 'more-agent-work.md'), 'more\n')

    const result = await commitAndPushWorkingTree(cfg, { message: 'more work' })

    expect(result).toMatchObject({ committed: true, pushed: true, branch: 'session-abc' })
    expect(git(['rev-parse', 'refs/heads/session-abc'], target)).not.toBe(baseSha)
    // The workspace diff reads refs/remotes/origin/<base> — it must exist.
    expect(git(['rev-parse', 'refs/remotes/origin/main'], target)).toBe(baseSha)
    // The earlier session work survived: the pushed branch history contains it.
    expect(git(['log', '--format=%s', 'refs/heads/session-abc'], remote)).toContain('agent work')
    expect(git(['ls-remote', remote, 'refs/heads/session-abc'])).toContain(
      git(['rev-parse', 'refs/heads/session-abc'], target),
    )
  })

  it('never overwrites an untracked file the base checkout would collide with', async () => {
    const { remote, target } = workspaceWithUnmaterializedTarget()
    writeFileSync(join(target, 'README.md'), 'the agent wrote this\n')
    const cfg = testConfig({
      projectTarget: target,
      repoUrl: remote,
      defaultBranch: 'main',
      branchName: 'session-abc',
    })

    await expect(commitAndPushWorkingTree(cfg, { message: 'agent work' })).rejects.toThrow(
      'git checkout failed',
    )
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('the agent wrote this\n')
  })

  it('re-materializes a failed earlier attempt instead of committing a root commit', async () => {
    // A materialize that dies mid-run (here: a checkout collision) leaves .git
    // with an UNBORN head — readRepoInfo answers non-null with branch/commit
    // null. The next commit-push must re-materialize (every step is
    // idempotent), never commit onto the unborn head: that creates a root
    // commit holding only the agent files, and a CR merged from it deletes
    // every base file.
    const { remote, target, baseSha } = workspaceWithUnmaterializedTarget()
    const cfg = testConfig({
      projectTarget: target,
      repoUrl: remote,
      defaultBranch: 'main',
      branchName: 'session-abc',
    })
    writeFileSync(join(target, 'README.md'), 'the agent wrote this\n')
    await expect(commitAndPushWorkingTree(cfg, { message: 'first try' })).rejects.toThrow(
      'git checkout failed',
    )
    // The failed attempt left a half-materialized repo (unborn HEAD).
    const half = await readRepoInfo(target)
    expect(half).not.toBeNull()
    expect(half?.branch).toBeNull()
    expect(half?.commit).toBeNull()

    // The agent resolves the collision; the next commit-push recovers.
    rmSync(join(target, 'README.md'))
    const result = await commitAndPushWorkingTree(cfg, { message: 'agent work' })

    expect(result).toMatchObject({ committed: true, pushed: true, branch: 'session-abc' })
    expect(git(['rev-parse', 'refs/heads/session-abc^'], target)).toBe(baseSha)
    expect(git(['ls-tree', '--name-only', 'refs/heads/session-abc'], remote).split('\n'))
      .toEqual(expect.arrayContaining(['README.md', 'agent-notes.md']))
  })

  it('still refuses when no repository is connected', async () => {
    const { target } = workspaceWithUnmaterializedTarget()
    const cfg = testConfig({ projectTarget: target, repoUrl: undefined })

    await expect(commitAndPushWorkingTree(cfg, { message: 'agent work' })).rejects.toThrow(
      'project repo is not materialized',
    )
    // The refusal left the workspace alone.
    expect(readFileSync(join(target, 'agent-notes.md'), 'utf8')).toBe('agent work\n')
  })
})
