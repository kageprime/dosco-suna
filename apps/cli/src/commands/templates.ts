/**
 * `kortix templates` — the hand-approved templates (`@kortix/starter/templates`)
 * and adding one to the repository you stand in: its `.kortix/<id>/` folder
 * plus one line under `imports:` in `kortix.yaml`. The one-prompt setup guide
 * drives `add --json` and acts on the `next` steps it prints.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { SETUP_GUIDE } from '@kortix/shared/setup-guide';
import { composeTemplateOnboarding, getTemplate, getTemplateFiles, isTemplateId, listTemplates, TEMPLATE_IDS, type TemplateInfo } from '@kortix/starter/templates';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { githubRepoFromRemote } from '../github-remote.ts';
import { runGit } from '../git-run.ts';
import { addManifestImport } from '../manifest-edit.ts';
import { runTemplatesDoctor } from './templates-doctor.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix templates <command> [options]

Hand-approved sets of agents and triggers. Adding one writes .kortix/<id>/ and
adds it under imports: in kortix.yaml. Nothing reaches Kortix until you push.

Commands:
  ls                     List the templates.
  show <id>              The template's agents, triggers, secrets and webhooks.
  doctor <id>            One green/red list: is the template ready to run?
                         Exit 1 while any line is red. --repo, --json.
  onboard <id>           Print the steps a coding agent follows to set the
                         template up with you: its own onboarding, then the
                         setup guide with the template chosen.
  add <id>               Add the template to the repository in this directory.

Options for add:
  --repo <owner/repo>    The GitHub repository. Default: the origin remote.
  --branch <name>        The default branch. Default: origin's HEAD, else the current branch.
  --force                Overwrite template files that differ.

Options:
  --json                 Print JSON.
  -h, --help             Show this help.

Templates: ${TEMPLATE_IDS.join(', ')}
`;

function fail(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 1;
}

function gitRoot(): string {
  const result = runGit(undefined, ['rev-parse', '--show-toplevel']);
  return result.ok ? result.stdout.trim() : process.cwd();
}

export { githubRepoFromRemote };

function inferRepo(root: string): string | null {
  const remote = runGit(root, ['remote', 'get-url', 'origin']);
  return remote.ok ? githubRepoFromRemote(remote.stdout) : null;
}

function inferBranch(root: string): string {
  const head = runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '');
  const current = runGit(root, ['branch', '--show-current']);
  return current.ok && current.stdout.trim() ? current.stdout.trim() : 'main';
}

function nextSteps(template: TemplateInfo) {
  return {
    secrets: template.secrets,
    github_webhooks: template.github_webhooks,
    label: template.label ?? null,
    needs_dev_sandbox: template.needs_dev_sandbox,
  };
}

function printTemplate(template: TemplateInfo): void {
  process.stdout.write(`${C.bold}${template.name}${C.reset}  ${C.dim}${template.id}${C.reset}\n  ${template.summary}\n`);
}

function runList(json: boolean): number {
  const templates = listTemplates();
  if (json) {
    process.stdout.write(`${JSON.stringify({ templates }, null, 2)}\n`);
    return 0;
  }
  for (const template of templates) printTemplate(template);
  process.stdout.write(`\n${C.dim}Add one: kortix templates add <id>${C.reset}\n`);
  return 0;
}

function runShow(id: string | undefined, json: boolean): number {
  if (!isTemplateId(id)) return fail(`Name a template: ${TEMPLATE_IDS.join(', ')}`);
  const template = getTemplate(id);
  if (json) {
    process.stdout.write(`${JSON.stringify({ template }, null, 2)}\n`);
    return 0;
  }
  printTemplate(template);
  process.stdout.write(`\n  Secrets:\n`);
  for (const secret of template.secrets) {
    process.stdout.write(`    ${secret.name}${secret.required ? '' : ' (optional)'}  ${C.dim}${secret.why}${C.reset}\n`);
  }
  for (const hook of template.github_webhooks) {
    process.stdout.write(`  GitHub webhook: ${hook.events.join(', ')} → trigger ${hook.trigger}\n`);
  }
  return 0;
}

function runAdd(argv: string[], json: boolean): number {
  const repoFlag = takeFlagValue(argv, ['--repo']);
  const branchFlag = takeFlagValue(argv, ['--branch']);
  const force = takeFlagBool(argv, ['--force']);
  const [id, ...extra] = argv;
  if (extra.length > 0) return fail(`Unexpected argument: ${extra[0]}`);
  if (!isTemplateId(id)) return fail(`Name a template: ${TEMPLATE_IDS.join(', ')}`);

  const root = gitRoot();
  const repoFullName = repoFlag ?? inferRepo(root);
  if (!repoFullName || !/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
    return fail('No GitHub repository found: add an origin remote on github.com, or pass --repo <owner/repo>.');
  }
  const defaultBranch = branchFlag ?? inferBranch(root);
  const template = getTemplate(id);
  const files = getTemplateFiles(id, { repoFullName, defaultBranch });

  const conflicts = files.filter((file) => {
    const abs = join(root, file.path);
    return existsSync(abs) && readFileSync(abs, 'utf8') !== file.content;
  });
  if (conflicts.length > 0 && !force) {
    return fail(`These files exist and differ: ${conflicts.map((file) => file.path).join(', ')}. Pass --force to overwrite.`);
  }
  const written: string[] = [];
  for (const file of files) {
    const abs = join(root, file.path);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === file.content) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
    written.push(file.path);
  }

  const existing = manifestCandidatePaths().map((path) => join(root, path)).find((path) => existsSync(path));
  const manifest = existing ?? join(root, 'kortix.yaml');
  if (!existing) {
    writeFileSync(
      manifest,
      [
        '# yaml-language-server: $schema=https://kortix.com/schema/kortix.schema.json',
        '# Kortix: the agents that work on this repository, and what starts them.',
        '# Reference: https://kortix.com/docs/developers#kortixyaml-reference',
        '',
        'project:',
        `  name: ${JSON.stringify(basename(root))}`,
        '',
        'builtin_agents:',
        '  my_kortix: true',
        '',
        'default_agent: mykortix',
        '',
      ].join('\n'),
    );
  }
  const imported = addManifestImport(manifest, template.import_path);

  const result = {
    template: template.id,
    repository: repoFullName,
    default_branch: defaultBranch,
    manifest: basename(manifest),
    manifest_created: !existing,
    import: imported,
    written,
    next: nextSteps(template),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${status.ok(`${template.name} added for ${repoFullName} (${defaultBranch})`)}\n`);
  process.stdout.write(`${status.info(`${written.length} files under ${template.import_path}; ${basename(manifest)} ${imported === 'added' ? 'imports it' : 'already imported it'}`)}\n`);
  process.stdout.write(`\n  Next:\n`);
  for (const secret of template.secrets) {
    const how = secret.generate ? 'a random value' : 'your value';
    process.stdout.write(`    Set ${secret.name}${secret.required ? '' : ' (optional)'} to ${how}: ${C.dim}${secret.why}${C.reset}\n`);
  }
  for (const hook of template.github_webhooks) {
    process.stdout.write(`    Create a GitHub webhook for ${hook.events.join(', ')} → trigger ${hook.trigger}\n`);
  }
  process.stdout.write(`    Then: kortix validate && kortix ship\n`);
  return 0;
}

function runOnboard(id: string | undefined): number {
  if (!isTemplateId(id)) return fail(`Name a template: ${TEMPLATE_IDS.join(', ')}`);
  process.stdout.write(composeTemplateOnboarding(id, SETUP_GUIDE));
  return 0;
}

export async function runTemplates(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    return args.length === 0 ? 1 : 0;
  }
  const json = takeFlagBool(args, ['--json']);
  const [command, ...rest] = args;
  if (command === 'ls' || command === 'list') return rest.length > 0 ? fail(`Unexpected argument: ${rest[0]}`) : runList(json);
  if (command === 'show') return runShow(rest[0], json);
  if (command === 'add') return runAdd(rest, json);
  if (command === 'onboard') return runOnboard(rest[0]);
  if (command === 'doctor') {
    const repoFlag = takeFlagValue(rest, ['--repo']);
    if (!isTemplateId(rest[0])) return fail(`Name a template: ${TEMPLATE_IDS.join(', ')}`);
    const top = runGit(undefined, ['rev-parse', '--show-toplevel']);
    const repo = repoFlag ?? inferRepo(top.ok ? top.stdout.trim() : process.cwd());
    return runTemplatesDoctor(getTemplate(rest[0]), { repo, json });
  }
  return fail(`Unknown command: templates ${command}. Run kortix templates --help.`);
}
