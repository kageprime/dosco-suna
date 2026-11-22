export async function rejectFocusedTests(root = process.cwd()): Promise<void> {
  // git grep, never rg: GitHub's runner images ship no ripgrep. It searches
  // tracked and untracked files minus .gitignore (no node_modules), and exits
  // 1 on no match, like rg.
  // A pathspec `*` crosses directories, so `apps/*.test.ts` is recursive.
  const extensions = ['spec.ts', 'test.ts', 'test.tsx', 'test.mts', 'test.js', 'test.mjs'];
  const child = Bun.spawn(
    [
      'git',
      'grep',
      '--untracked',
      '-n',
      '-E',
      String.raw`(^|[^A-Za-z0-9_$.])(describe|test|it)\.only\(`,
      '--',
      ...['apps', 'packages', 'tests', 'scripts', 'infra'].flatMap((dir) =>
        extensions.map((ext) => `${dir}/*.${ext}`),
      ),
    ],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code === 1) return;
  if (code !== 0) throw new Error(`focused-test scan exited with code ${code}`);
  process.stderr.write(output);
  throw new Error('focused test (.only) committed');
}

if (import.meta.main) await rejectFocusedTests();
