/**
 * Run another `kortix` command as a child process of this one: the same
 * binary (or the same `bun src/index.ts`), the same environment. Onboarding
 * uses it for `kortix ship`, whose output is for people, so it stays out of
 * onboarding's JSON.
 */
export function selfCommand(): string[] {
  const main = typeof Bun !== 'undefined' ? Bun.main : process.argv[1] ?? '';
  // A compiled binary is its own entry; a checkout runs through bun.
  return /\.(ts|js|mjs)$/.test(main) && !main.startsWith('/$bunfs') ? [process.execPath, main] : [process.execPath];
}

export async function runSelf(args: string[], cwd: string, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [...selfCommand(), ...args],
    cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', KORTIX_NO_UPDATE_CHECK: '1' },
    stdin: stdin === undefined ? 'ignore' : new Blob([`${stdin}\n`]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
