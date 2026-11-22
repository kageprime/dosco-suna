/**
 * `kortix templates doctor <id>` — the loops doctor (`kortix doctor --loops`)
 * plus what only the template knows: its file (`<id>.yaml`) is imported, the secrets its
 * template.json lists that kortix.yaml does not name (an agent granted
 * `secrets: "*"`), and a dev sandbox when the template needs one.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { manifestCandidatePaths, parseManifestText } from '@kortix/manifest-schema';
import { getTemplate, getTemplateFiles, type TemplateInfo } from '@kortix/starter/templates';
import { type Check, doctorExitCode } from '../onboarding/loops-doctor.ts';
import { C, status } from '../style.ts';
import { doctorChecks, loadLoopsState } from './onboard.ts';

export type { Check, CheckState } from '../onboarding/loops-doctor.ts';
export { doctorExitCode };

/** Trigger slugs the template's import file (`<id>.yaml`) declares, read from the repository. */
export function templateTriggerSlugs(root: string, template: TemplateInfo): string[] {
  const file = join(root, template.import_path);
  // Read directly: a missing file or a directory throws, with no window between a check and the read.
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const doc = parseManifestText(text) as { triggers?: Array<{ slug?: string }> };
  return (doc.triggers ?? []).flatMap((trigger) => (trigger.slug ? [trigger.slug] : []));
}

/** The template's folder of the old layout (`.kortix/<id>/`), when the repository still has it. */
export function legacyTemplateFolder(root: string, template: TemplateInfo): string | null {
  const folder = `.kortix/${template.id}`;
  return existsSync(join(root, folder)) ? `${folder}/` : null;
}

/** All text of the template's files in the repository: what this repository really runs. */
export function installedText(root: string, template: TemplateInfo): string {
  const paths = getTemplateFiles(template.id, { repoFullName: 'owner/repo', defaultBranch: 'main' }).map((file) => file.path);
  return paths
    .map((path) => join(root, path))
    .filter((abs) => existsSync(abs) && statSync(abs).isFile())
    .map((abs) => readFileSync(abs, 'utf8'))
    .join('');
}

export async function runTemplatesDoctor(template: TemplateInfo, opts: { repo: string | null; json: boolean }): Promise<number> {
  const { state, manifestFile } = await loadLoopsState({
    repo: opts.repo,
    options: { envFiles: [], allowRemote: false, channels: [], connect: [], githubToken: null, buildTimeoutSec: 1800, message: 'chore: add Kortix loops' },
  });
  const root = state.root;
  const manifest = manifestCandidatePaths().map((path) => join(root, path)).find((path) => existsSync(path));
  const imported = manifest ? readFileSync(manifest, 'utf8').includes(template.import_path) : false;
  const declared = templateTriggerSlugs(root, template);
  const legacy = legacyTemplateFolder(root, template);
  const checks: Check[] = [
    imported && declared.length > 0
      ? { name: 'template added', state: 'ok', detail: `${template.import_path} imported, ${declared.length} triggers` }
      : legacy
        ? { name: 'template added', state: 'fail', detail: `old layout: the template is in ${legacy}. Move its agent to agents/, its skills to skills/, its YAML and JSON to the root, and import ${template.import_path}` }
        : { name: 'template added', state: 'fail', detail: 'not in this repository', fix: `kortix templates add ${template.id}` },
    ...(await doctorChecks(state, manifestFile)),
  ];

  // Secrets the template lists that kortix.yaml does not name: a repository set
  // up with an older version is asked only for the names its own files use.
  if (state.ctx) {
    const named = new Set(state.needs.secrets.map((s) => s.name));
    const installed = installedText(root, template);
    const extra = template.secrets.filter((s) => !named.has(s.name) && installed.includes(s.name));
    if (extra.length) {
      const rows = await state.ctx.client.get<{ items?: Array<{ name: string; configured: boolean }> }>(`/workspaces/${state.ctx.projectId}/secrets`).catch(() => null);
      const set = new Set((rows?.items ?? []).filter((r) => r.configured).map((r) => r.name));
      const missing = extra.filter((s) => s.required && !set.has(s.name)).map((s) => s.name);
      const optional = extra.filter((s) => !s.required && !set.has(s.name)).map((s) => s.name);
      checks.push(
        missing.length
          ? { name: 'template secrets', state: 'fail', detail: `missing: ${missing.join(', ')}`, fix: `kortix secrets request ${missing.join(' ')} --scope runtime` }
          : { name: 'template secrets', state: optional.length ? 'warn' : 'ok', detail: optional.length ? `optional not set: ${optional.join(', ')}` : 'every secret is set' },
      );
    }
  }
  if (template.needs_dev_sandbox && state.needs.sandbox_templates.length === 0) {
    checks.push({ name: 'dev image', state: 'fail', detail: 'kortix.yaml declares no sandbox template', fix: 'add sandbox.templates + sandbox.default to kortix.yaml (setup guide step 5)' });
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ template: template.id, ready: doctorExitCode(checks) === 0, checks }, null, 2)}\n`);
    return doctorExitCode(checks);
  }
  process.stdout.write(`\n  ${C.bold}${template.name}${C.reset}\n\n`);
  for (const check of checks) {
    const line = `${check.name}: ${check.detail}`;
    process.stdout.write(`${check.state === 'ok' ? status.ok(line) : check.state === 'warn' ? status.warn(line) : status.err(line)}\n`);
    if (check.fix && check.state !== 'ok') process.stdout.write(`       ${C.dim}fix: ${check.fix}${C.reset}\n`);
  }
  const code = doctorExitCode(checks);
  process.stdout.write(`\n  ${code === 0 ? 'Ready.' : 'Not ready: fix the red lines, then run this again.'}\n\n`);
  return code;
}

export { getTemplate };
