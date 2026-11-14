/**
 * `kortix templates doctor <id>` — the loops doctor (`kortix doctor --loops`)
 * plus what only the template knows: its folder is imported, the secrets its
 * template.json lists that kortix.yaml does not name (an agent granted
 * `secrets: "*"`), and a dev sandbox when the template needs one.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifestCandidatePaths, parseManifestText } from '@kortix/manifest-schema';
import { getTemplate, type TemplateInfo } from '@kortix/starter/templates';
import { type Check, doctorExitCode } from '../onboarding/loops-doctor.ts';
import { C, status } from '../style.ts';
import { doctorChecks, loadLoopsState } from './onboard.ts';

export type { Check, CheckState } from '../onboarding/loops-doctor.ts';
export { doctorExitCode };

/** Trigger slugs the template's rendered YAML declares, read from the repository. */
export function templateTriggerSlugs(root: string, template: TemplateInfo): string[] {
  const dir = join(root, template.import_path);
  if (!existsSync(dir)) return [];
  const slugs: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(entry.name)) {
        const doc = parseManifestText(readFileSync(full, 'utf8')) as { triggers?: Array<{ slug?: string }> };
        for (const trigger of doc.triggers ?? []) if (trigger.slug) slugs.push(trigger.slug);
      }
    }
  };
  walk(dir);
  return slugs;
}

/** All text of the installed template folder: what this repository really runs. */
export function installedText(root: string, template: TemplateInfo): string {
  const dir = join(root, template.import_path);
  if (!existsSync(dir)) return '';
  let text = '';
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else text += readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return text;
}

export async function runTemplatesDoctor(template: TemplateInfo, opts: { repo: string | null; json: boolean }): Promise<number> {
  const { state, manifestFile } = await loadLoopsState({
    repo: opts.repo,
    options: { envFiles: [], allowRemote: false, channels: [], connect: [], githubToken: null, buildTimeoutSec: 1800, message: 'chore: add Kortix loops' },
  });
  const root = state.root;
  const manifest = manifestCandidatePaths().map((path) => join(root, path)).find((path) => existsSync(path));
  const imported = manifest ? readFileSync(manifest, 'utf8').includes(template.import_path.replace(/\/$/, '')) : false;
  const declared = templateTriggerSlugs(root, template);
  const checks: Check[] = [
    imported && declared.length > 0
      ? { name: 'template added', state: 'ok', detail: `${template.import_path} imported, ${declared.length} triggers` }
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
