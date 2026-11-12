/**
 * The workspace diff's process contract (KRTX-4601).
 *
 * `vcsDiff` runs on every Changes-tab refetch — on the box's own CPU, while
 * the agent is working. Its cost ceiling is part of the contract: generating
 * the untracked files' patches must cost a bounded number of git processes,
 * not one per file. The per-file `git diff --no-index /dev/null <file>` loop
 * (up to 200 sequential spawns per poll) was the route's dominant CPU cost —
 * ~94 % of a measured diff — and inflated the route's p95 to seconds on busy
 * boxes, with every other daemon route queueing behind it.
 */
import { describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as gitModule from '@/lib/git/git'

let gitSpawns = 0
const realRunGit = gitModule.runGit
mock.module('@/lib/git/git', () => ({
  ...gitModule,
  runGit: (...args: Parameters<typeof realRunGit>) => {
    gitSpawns++
    return realRunGit(...args)
  },
}))

// Imported after the mock, so vcs-diff binds the counting spy.
const { vcsDiff } = await import('@/lib/git/vcs-diff')

/** A tiny repo: one committed file tree, ready for the caller to dirty. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-vcs-diff-'))
  const git = (args: string[]) => realRunGit(args, { cwd: root })
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'test@kortix.local'])
  await git(['config', 'user.name', 'Kortix Test'])
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/one.ts'), 'one\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  return root
}

describe('vcsDiff', () => {
  test('lists tracked modifications and untracked additions with patches', async () => {
    const root = await makeRepo()
    try {
      await writeFile(join(root, 'src/one.ts'), 'one\ntwo\n')
      await writeFile(join(root, 'new.txt'), 'a\nb\nc\n')
      const files = await vcsDiff(root, 'branch', 'main')
      const one = files.find((f) => f.file === 'src/one.ts')
      expect(one?.status).toBe('modified')
      expect(one?.additions).toBe(1)
      expect(one?.patch).toContain('+two')
      const added = files.find((f) => f.file === 'new.txt')
      expect(added?.status).toBe('added')
      expect(added?.additions).toBe(3)
      expect(added?.deletions).toBe(0)
      expect(added?.patch).toContain('new file mode')
      expect(added?.patch).toContain('+c')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('generates the untracked patches in a bounded number of git processes', async () => {
    const root = await makeRepo()
    try {
      // 60 untracked files: the old per-file loop spawns one git per file on
      // top of the fixed calls; the batched pass adds at most three more.
      for (let i = 0; i < 60; i++) await writeFile(join(root, `out-${i}.txt`), `content ${i}\n`)
      gitSpawns = 0
      const files = await vcsDiff(root, 'branch', 'main')
      expect(files.filter((f) => f.file.startsWith('out-')).every((f) => f.patch)).toBe(true)
      expect(gitSpawns).toBeLessThanOrEqual(12)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a file over the patch budget keeps its counts and loses its patch', async () => {
    const root = await makeRepo()
    try {
      await writeFile(join(root, 'big.txt'), 'line\n'.repeat(120_000))
      const files = await vcsDiff(root, 'branch', 'main')
      const big = files.find((f) => f.file === 'big.txt')
      expect(big?.status).toBe('added')
      expect(big?.additions).toBeGreaterThan(0)
      expect(big?.patch).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('past the untracked cap a file is listed with no patch and no counts', async () => {
    const root = await makeRepo()
    try {
      // The cap is 200; one over it pins the degraded-row contract. Zero-padded
      // names so ls-files' byte sort is the numeric order the cap cuts at.
      for (let i = 0; i < 201; i++) await writeFile(join(root, `many-${String(i).padStart(3, '0')}.txt`), 'x\n')
      const files = await vcsDiff(root, 'branch', 'main')
      const over = files.find((f) => f.file === 'many-200.txt')
      expect(over?.status).toBe('added')
      expect(over?.patch).toBeUndefined()
      expect(over?.additions).toBe(0)
      const under = files.find((f) => f.file === 'many-000.txt')
      expect(under?.patch).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an untracked path the ref already knows still gets its new-file patch', async () => {
    const root = await makeRepo()
    try {
      // `git rm --cached` leaves the file on disk but in the comparison ref's
      // tree. Its patch must stay a plain new-file diff — and one such path
      // must not cost the other untracked files their patches.
      await writeFile(join(root, 'kept.txt'), 'kept\n')
      await realRunGit(['add', 'kept.txt'], { cwd: root })
      await realRunGit(['commit', '-qm', 'kept'], { cwd: root })
      await realRunGit(['rm', '--cached', '-q', 'kept.txt'], { cwd: root })
      await writeFile(join(root, 'fresh.txt'), 'fresh\n')
      const files = await vcsDiff(root, 'branch', 'main')
      // The tracked diff also reports kept.txt as deleted (pre-existing shape);
      // the untracked pass must add its own row with the new-file patch.
      const kept = files.find((f) => f.file === 'kept.txt' && f.status === 'added')
      expect(kept?.status).toBe('added')
      expect(kept?.additions).toBe(1)
      expect(kept?.patch).toContain('+kept')
      const fresh = files.find((f) => f.file === 'fresh.txt')
      expect(fresh?.patch).toContain('+fresh')
      expect(fresh?.additions).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an untracked nested repository costs the other files nothing', async () => {
    const root = await makeRepo()
    try {
      // `ls-files --others` lists an embedded repo as `dir/` — a row the old
      // per-file diff degraded on its own, wherever it sorts. The batch must
      // keep that isolation without shifting a patch onto the wrong row.
      await realRunGit(['init', '-q', 'aaa-nested'], { cwd: root })
      await writeFile(join(root, 'aaa-nested/f.txt'), 'x\n')
      await writeFile(join(root, 'fresh.txt'), 'fresh\n')
      const files = await vcsDiff(root, 'branch', 'main')
      const fresh = files.find((f) => f.file === 'fresh.txt')
      expect(fresh?.status).toBe('added')
      expect(fresh?.additions).toBe(1)
      expect(fresh?.patch).toContain('+fresh')
      const nested = files.find((f) => f.file === 'aaa-nested/')
      expect(nested?.status).toBe('added')
      expect(nested?.patch).toBeUndefined()
      expect(nested?.additions).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a failing required clean filter costs the other files nothing', async () => {
    const root = await makeRepo()
    try {
      // git-lfs is the real case: a required clean filter with no filter
      // binary fails every diff that converts the file's content — the batch
      // and the per-file diff alike. The per-file fallback keeps that failure
      // on the bad file's row alone, the old loop's isolation.
      await writeFile(join(root, '.gitattributes'), 'bad.txt filter=bad\n')
      await realRunGit(['config', 'filter.bad.clean', 'false'], { cwd: root })
      await realRunGit(['config', 'filter.bad.required', 'true'], { cwd: root })
      await writeFile(join(root, 'bad.txt'), 'bad\n')
      await writeFile(join(root, 'good.txt'), 'good\n')
      const files = await vcsDiff(root, 'branch', 'main')
      const good = files.find((f) => f.file === 'good.txt')
      expect(good?.additions).toBe(1)
      expect(good?.patch).toContain('+good')
      const bad = files.find((f) => f.file === 'bad.txt')
      expect(bad?.status).toBe('added')
      expect(bad?.additions).toBe(0)
      expect(bad?.patch).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an executable untracked file keeps its mode with core.filemode off', async () => {
    const root = await makeRepo()
    try {
      // The default on several filesystems: git ignores the exec bit. The
      // per-file diff it replaces reported the real mode; the batch must too.
      // Git's own exec test is the OWNER bit: 0654 (group/other exec only) is
      // a plain 100644 file.
      await realRunGit(['config', 'core.filemode', 'false'], { cwd: root })
      await writeFile(join(root, 'tool.sh'), '#!/bin/sh\necho hi\n')
      await writeFile(join(root, 'shared.sh'), '#!/bin/sh\necho shared\n')
      const { chmod } = await import('node:fs/promises')
      await chmod(join(root, 'tool.sh'), 0o755)
      await chmod(join(root, 'shared.sh'), 0o654)
      const files = await vcsDiff(root, 'branch', 'main')
      const tool = files.find((f) => f.file === 'tool.sh')
      expect(tool?.patch).toContain('new file mode 100755')
      expect(tool?.patch).toContain('echo hi')
      const shared = files.find((f) => f.file === 'shared.sh')
      expect(shared?.patch).toContain('new file mode 100644')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a repo diff.orderFile cannot mislabel the untracked patches', async () => {
    const root = await makeRepo()
    try {
      // A reversed order file reorders the batch's patch output; the chunks
      // must still land on their own files.
      const order = join(root, 'order-file')
      await writeFile(order, 'z.txt\na.txt\n')
      await realRunGit(['config', 'diff.orderFile', order], { cwd: root })
      await writeFile(join(root, 'a.txt'), 'aaa\n')
      await writeFile(join(root, 'z.txt'), 'zzz\n')
      const files = await vcsDiff(root, 'branch', 'main')
      const a = files.find((f) => f.file === 'a.txt')
      expect(a?.patch).toContain('+aaa')
      expect(a?.patch).not.toContain('+zzz')
      const z = files.find((f) => f.file === 'z.txt')
      expect(z?.patch).toContain('+zzz')
      expect(z?.patch).not.toContain('+aaa')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a directory that is not a git repo has no changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-vcs-diff-plain-'))
    try {
      expect(await vcsDiff(root, 'branch', 'main')).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
