/**
 * `kortix plan` — the deterministic, read-only baseline of a repository before
 * a cloud dev environment and loops are set up on it: repository, stack, env
 * files key by key (names and classes, never a value), integrations, the
 * Kortix state, and a dev-environment proposal. A coding agent reads it, agrees
 * one plan with the person, then runs `kortix onboard --yes`.
 */
import { resolve } from 'node:path';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { runGit } from '../git-run.ts';
import { readKortixState, REFERENCE_REPOS } from '../onboarding/kortix-state.ts';
import { envValues, listFiles, proposeDevEnv, scanEnv, scanCodeEnvNames, scanIntegrations, scanMcpServers, scanRepository, scanStack, scanUnrecognized, scrubValues } from '../onboarding/repo-scan.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix plan [options]

Read this repository and print what a cloud dev environment and Kortix loops
need: repository and monorepo layout, languages and services, dev/test/e2e
commands, every env file key by key, integrations, the Kortix state, and a
dev-environment proposal. Read-only: it changes nothing here or on Kortix.

Env values are read in this process only to classify each key:
  local    a value for this machine (or no URL)
  remote   a URL on another host, or a staging/preview file
  prod     a production file, a PROD/LIVE key name, or a live-mode key (sk_live_)
No value, and no part of one, is printed. Classes come from names and URL
hosts only: a generic DATABASE_URL that holds a production URL is "remote".

Options:
  --dir <path>   The repository (default: the git root of this directory).
  --json         Print JSON.
  -h, --help     Show this help.

Next: agree the plan with the person, then \`kortix onboard --yes --json\`.
`;

export async function buildPlan(dir: string) {
  const top = runGit(dir, ['rev-parse', '--show-toplevel']);
  const root = top.ok ? top.stdout.trim() : dir;
  const fileList = listFiles(root);
  const repository = scanRepository(root, new Set(fileList));
  const stack = scanStack(root, fileList, repository);
  const env = scanEnv(root, fileList);
  const named = scanCodeEnvNames(root, fileList, stack);
  const integrations = scanIntegrations(root, fileList, repository, env, named);
  const unrecognized = scanUnrecognized(env, named);
  const envToPush = env.files
    .filter((file) => !file.example && !file.dotenvx_keys)
    .flatMap((file) => file.keys.filter((k) => k.class === 'local' && !k.empty && !k.encrypted).map((k) => ({ file: file.file, name: k.name })));
  const valueFiles = env.files.filter((file) => !file.example && !file.dotenvx_keys);
  const mcpServers = scanMcpServers(root, fileList);
  process.chdir(root);
  const kortix = await readKortixState(root);
  return scrubValues({
    repository,
    stack,
    env,
    integrations,
    unrecognized_services: unrecognized,
    mcp_servers: mcpServers,
    kortix,
    recommendation: {
      references: REFERENCE_REPOS.map((ref) => ({ ...ref, status: 'published' as const })),
      dev_environment: proposeDevEnv(stack, env, { workerd: integrations.some((i) => i.name === 'Cloudflare') }),
      env_to_push: envToPush,
      /** Why the list is empty: an agent must not read that as "nothing is needed". */
      env_to_push_reason: envToPush.length
        ? null
        : valueFiles.length === 0
          ? env.files.some((file) => file.example)
            ? 'no env file with values here: only an example file. Ask the person where the dev values are'
            : 'this repository has no env file'
          : 'every value is empty, encrypted, remote or production: none is safe to push without the person',
    },
  }, envValues(root, fileList));
}

function printPlan(plan: Awaited<ReturnType<typeof buildPlan>>): void {
  const { repository: repo, stack, env, integrations, unrecognized_services: unrecognized, mcp_servers: mcpServers, kortix } = plan;
  const line = (label: string, value: string) => process.stdout.write(`  ${C.dim}${label.padEnd(14)}${C.reset}${value}\n`);
  process.stdout.write(`\n  ${C.bold}kortix plan${C.reset}  ${C.dim}${repo.root}${C.reset}\n\n`);
  line('repository', `${repo.github ? `${repo.github.owner}/${repo.github.repo}` : `origin: ${repo.origin}`} · ${repo.default_branch ?? 'no branch'} · ${repo.clean ? 'clean' : `${repo.changed_files} changed files`}`);
  if (repo.layout.workspaces.length) line('monorepo', `${repo.layout.workspaces.join(', ')}: ${repo.layout.apps.length} apps, ${repo.layout.packages.length} packages`);
  line('languages', stack.languages.map((l) => (l.version ? `${l.name} ${l.version}` : l.name)).join(', ') || 'none found');
  line('packages', stack.package_managers.map((m) => m.name).join(', ') || 'none found');
  if (stack.services.length) line('services', stack.services.map((s) => s.name).join(', '));
  if (stack.browser_tests.length) line('browser tests', stack.browser_tests.map((b) => b.tool).join(', '));
  line('env files', `${env.files.length} files, ${env.files.reduce((n, f) => n + f.keys.length, 0)} keys`);
  for (const file of env.files) {
    const count = (cls: string) => file.keys.filter((k) => k.class === cls).length;
    process.stdout.write(`    ${file.file}  ${C.dim}${count('local')} local, ${count('remote')} remote, ${count('prod')} prod${file.example ? ' (example)' : ''}${C.reset}\n`);
  }
  if (integrations.length) line('integrations', integrations.map((i) => i.name).join(', '));
  if (unrecognized.length) line('unrecognized', `${unrecognized.map((u) => u.prefix).join(', ')} ${C.dim}(ask the person what each is)${C.reset}`);
  if (mcpServers.length) line('mcp servers', mcpServers.map((m) => m.name).join(', '));
  line('kortix', kortix.signed_in ? `signed in to ${kortix.host ?? 'default'}${kortix.workspace ? ` · workspace ${kortix.workspace.id}` : ' · no workspace linked'}` : 'not signed in (kortix login)');
  line('kortix.yaml', kortix.manifest ? `${kortix.manifest.file}${kortix.manifest.imports.length ? `, imports ${kortix.manifest.imports.join(', ')}` : ''}` : 'none');
  process.stdout.write(`\n  ${status.info('Agree the plan with the person, then run: kortix onboard --yes --json')}\n\n`);
}

export async function runPlan(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, HELP, (rest) => ({
    json: takeFlagBool(rest, ['--json']),
    dir: takeFlagValue(rest, ['--dir']),
  }));
  if (typeof flags === 'number') return flags;
  const plan = await buildPlan(resolve(flags.dir ?? process.cwd()));
  if (flags.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else printPlan(plan);
  return 0;
}
