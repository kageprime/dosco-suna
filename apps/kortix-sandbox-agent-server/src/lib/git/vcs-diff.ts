/**
 * The session checkout's changes: `GET /kortix/runtime/workspace/diff` and the
 * `/vcs/diff` the Changes tab reads today. The tab treats the project as tracked
 * only when the workspace reports `vcs: 'git'`, then reads the `branch` diff.
 *
 * The runtime wire's `VcsFileDiff` shape: one row per file with a git-format
 * patch, `additions`, `deletions` and `status`.
 *
 * - `git`: the working tree against HEAD, plus untracked files.
 * - `branch` (default): the same, against the merge base of HEAD and the
 *   project's default branch, so committed work stays listed.
 */
import { randomUUID } from 'node:crypto'
import { lstat as lstatCb, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGit } from './git'

const lstat = (path: string) => lstatCb(path).catch(() => null)

export interface VcsFileDiff {
  file: string
  patch?: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
}

// ponytail: per-file and total byte caps; a file over budget keeps its counts and loses its patch.
const MAX_FILE_PATCH_BYTES = 512 * 1024
const MAX_TOTAL_PATCH_BYTES = 8 * 1024 * 1024
// ponytail: untracked files' patches come from one throwaway-index `git diff --cached`; past the cap a file is listed with no patch or counts.
const MAX_UNTRACKED_PATCHES = 200
const GIT = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '--no-optional-locks']

const git = (
  cwd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
) => runGit([...GIT, ...args], { cwd, timeoutMs: 30_000, ...opts })

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']).catch(() => null)
  return r?.code === 0 && r.stdout.trim() === 'true'
}

/** The commit the diff compares against, or null when the repo has no HEAD yet. */
async function baseRef(cwd: string, mode: string, defaultBranch: string): Promise<string | null> {
  if ((await git(cwd, ['rev-parse', '--verify', 'HEAD'])).code !== 0) return null
  if (mode === 'branch') {
    for (const candidate of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
      const fork = await git(cwd, ['merge-base', candidate, 'HEAD'])
      if (fork.code === 0 && fork.stdout.trim()) return fork.stdout.trim()
    }
  }
  return 'HEAD'
}

/** +/- lines of a single-file patch, counted after its first hunk header. */
function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * The untracked files' patch text, generated as ONE batched git diff: a
 * throwaway index (GIT_INDEX_FILE), EMPTY, with the untracked files staged
 * into it from the working tree, then `git diff --cached` against the empty
 * tree. Every selected path comes out as a new-file patch — the exact text one
 * `git diff --no-index /dev/null <file>` per file produced, which cost one
 * spawn per file, up to 200 sequential spawns per poll on an agent-written
 * workspace: seconds of CPU the diff route (and every daemon route behind it)
 * pays on each UI refetch (KRTX-4601). The ref never enters it, so a path the
 * comparison base already knows (`git rm --cached`) still shows as an addition.
 * Undefined when git cannot build the batch (a failed required clean filter, a
 * vanished file); the caller then falls back to the per-file diffs.
 */
async function untrackedPatchText(cwd: string, files: string[]): Promise<string | undefined> {
  if (files.length === 0) return undefined
  const index = join(tmpdir(), `kortix-diff-${process.pid}-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    if ((await git(cwd, ['read-tree', '--empty'], { env })).code !== 0) return undefined
    const staged = await git(cwd, ['update-index', '--add', '-z', '--stdin'], { env, input: files.join('\0') + '\0' })
    if (staged.code !== 0) return undefined
    // `core.filemode=false` (the default on several filesystems) drops the
    // executable bit at staging, but the per-file diff it replaces reported
    // the real mode. Re-set it on the executable regular files (git's own test:
    // the OWNER exec bit — a group/other-only 0654 file is a plain 100644); a
    // no-op where filemode is already tracked.
    const modes = await Promise.all(files.map(async (f) => [f, await lstat(join(cwd, f))] as const))
    const exec = modes.filter(([, st]) => st?.isFile() && (st.mode & 0o100) !== 0).map(([f]) => f)
    if (exec.length > 0) {
      await git(cwd, ['update-index', '--chmod=+x', '-z', '--stdin'], { env, input: exec.join('\0') + '\0' })
    }
    // `-O/dev/null` overrides a repo's `diff.orderFile`: the chunk order must
    // stay the canonical sorted order the staged list was built in.
    const patch = await git(cwd, ['diff', '--cached', '--no-ext-diff', '-O/dev/null', EMPTY_TREE, '--', '.'], { env })
    return patch.code === 0 && patch.stdout ? patch.stdout : undefined
  } finally {
    await rm(index, { force: true }).catch(() => {})
  }
}

export async function vcsDiff(cwd: string, mode: string, defaultBranch: string): Promise<VcsFileDiff[]> {
  if (!(await isGitRepo(cwd))) return []
  const ref = (await baseRef(cwd, mode, defaultBranch)) ?? EMPTY_TREE
  const diff = (...flags: string[]) => git(cwd, ['diff', '--no-ext-diff', '--no-renames', ...flags, ref, '--', '.'])
  const [names, patches, untracked] = await Promise.all([
    diff('--name-status', '-z'),
    diff(),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']),
  ])
  if (names.code !== 0) throw new Error(`git diff failed: ${names.stderr.trim()}`)

  const fields = names.stdout.split('\0').filter(Boolean)
  const tracked: Array<{ file: string; status: VcsFileDiff['status'] }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]!
    tracked.push({ file: fields[i + 1]!, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified' })
  }
  // `git diff` writes the patch in the same order as `--name-status`: one `diff --git` chunk per file.
  const chunks = patches.code === 0 ? patches.stdout.split(/^(?=diff --git )/m).filter(Boolean) : []
  const chunkFor = (i: number) => (chunks.length === tracked.length ? chunks[i] : undefined)

  let budget = MAX_TOTAL_PATCH_BYTES
  const finish = (file: string, status: VcsFileDiff['status'], raw: string | undefined): VcsFileDiff => {
    // A binary or mode-only change has no hunk to render.
    const patch = raw && /^@@/m.test(raw) ? raw : undefined
    const counts = patch ? countPatch(patch) : { additions: 0, deletions: 0 }
    const bytes = patch ? Buffer.byteLength(patch) : 0
    const keep = patch !== undefined && bytes <= MAX_FILE_PATCH_BYTES && bytes <= budget
    if (keep) budget -= bytes
    return { file, status, additions: counts.additions, deletions: counts.deletions, ...(keep ? { patch } : {}) }
  }

  const rows = tracked.map((t, i) => finish(t.file, t.status, chunkFor(i)))
  const newFiles = untracked.code === 0 ? untracked.stdout.split('\0').filter(Boolean) : []
  // The cap counts the original entries (the old per-file loop's cap), then an
  // embedded repo (`dir/` — not stageable, no file patch) drops out of the
  // batch. The old per-file diff degraded just that row; filtering keeps the
  // other files' patches with it.
  const staged = newFiles.slice(0, MAX_UNTRACKED_PATCHES).filter((f) => !f.endsWith('/'))
  const batchChunks = (await untrackedPatchText(cwd, staged))?.split(/^(?=diff --git )/m).filter(Boolean) ?? []
  // `git diff --cached` writes the patch in the same sorted order as the staged
  // list: one `diff --git` chunk per staged file, keyed by path so a filtered
  // directory entry cannot shift a patch onto the wrong row. A batch that git
  // refused whole falls back to the per-file diffs, which isolate the bad file
  // again the way the pre-batch loop did.
  const chunkByFile = batchChunks.length === staged.length
    ? zipPairs(staged, batchChunks)
    : await perFilePatchTexts(cwd, staged)
  for (const [i, file] of newFiles.entries()) {
    rows.push(finish(file, 'added', i < MAX_UNTRACKED_PATCHES ? chunkByFile.get(file) : undefined))
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * The batch's fallback: one `git diff --no-index /dev/null <file>` per file —
 * the pre-batch cost, paid only when git refused the whole batch (a failing
 * required clean filter aborts `update-index` for every file; the old loop
 * degraded just the bad one). Exit 1 means "files differ", the normal answer.
 */
async function perFilePatchTexts(cwd: string, files: string[]): Promise<Map<string, string>> {
  const patches = new Map<string, string>()
  for (const file of files) {
    const r = await git(cwd, ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', file])
    if (r.code <= 1 && r.stdout) patches.set(file, r.stdout)
  }
  return patches
}

/** position → path/value pairs, when both lists are the same length. */
function zipPairs(paths: string[], chunks: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const [i, chunk] of chunks.entries()) {
    const path = paths[i]
    if (path !== undefined) map.set(path, chunk)
  }
  return map
}
