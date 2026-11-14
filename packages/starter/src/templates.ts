/**
 * Templates: hand-approved sets of agents and triggers that a repository adds
 * with one import line in its `kortix.yaml`. `kortix templates add` and the
 * one-prompt setup guide read them from here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import embeddedStarter from './embedded.generated.json' with { type: 'json' };
import { TEMPLATE_IDS, type TemplateId } from './template-ids';

export { TEMPLATE_IDS, type TemplateId };

export interface TemplateSecret {
  name: string;
  required: boolean;
  /** `sandbox`: the agents' environment. `connector`: only Kortix reads it (webhook secrets). */
  delivery: 'sandbox' | 'connector';
  why: string;
  /** Kortix may generate a random value: nobody has to bring one. */
  generate?: boolean;
}

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  summary: string;
  secrets: TemplateSecret[];
  /** GitHub repository webhooks to create: the trigger slug and its GitHub events. */
  github_webhooks: Array<{ trigger: string; events: string[] }>;
  label?: string;
  /** The template's agents run the repository's dev environment. */
  needs_dev_sandbox: boolean;
  /** The folder a repository imports, such as `.kortix/software-factory/`. */
  import_path: string;
}

export interface TemplateVars {
  /** `owner/repo` on GitHub. */
  repoFullName: string;
  defaultBranch: string;
}

// `import.meta.dir` is Bun's. Under Node (the web app) it is undefined, and the
// compiled-in snapshot serves the files.
const TEMPLATES_DIR: string | null = typeof import.meta.dir === 'string' ? join(import.meta.dir, '..', 'templates') : null;
const EMBEDDED = embeddedStarter as Record<string, { files: Array<{ path: string; content: string }> }>;

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value);
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === '.DS_Store' || entry === 'node_modules') continue;
    const abs = join(root, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

/** Raw files (placeholders intact): from disk in a checkout, else the compiled-in snapshot. */
function rawTemplateFiles(id: TemplateId): Array<{ path: string; content: string }> {
  const dir = TEMPLATES_DIR ? join(TEMPLATES_DIR, id) : null;
  if (dir && existsSync(dir)) {
    return walk(dir)
      .map((abs) => ({ path: relative(dir, abs).split(sep).join('/'), content: readFileSync(abs, 'utf8') }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  const embedded = EMBEDDED[`template:${id}`];
  if (!embedded) throw new Error(`template ${id} is not in this build`);
  return embedded.files;
}

export function getTemplate(id: TemplateId): TemplateInfo {
  const meta = rawTemplateFiles(id).find((file) => file.path === 'template.json');
  if (!meta) throw new Error(`template ${id} has no template.json`);
  const parsed = JSON.parse(meta.content) as Omit<TemplateInfo, 'import_path'>;
  return { ...parsed, id, github_webhooks: parsed.github_webhooks ?? [], import_path: `.kortix/${id}/` };
}

export function listTemplates(): TemplateInfo[] {
  return TEMPLATE_IDS.map(getTemplate);
}

/** The template's own onboarding steps (`onboarding.md` beside template.json), or null. */
export function getTemplateOnboarding(id: TemplateId): string | null {
  return rawTemplateFiles(id).find((file) => file.path === 'onboarding.md')?.content ?? null;
}

/** The files a repository receives, `{{repoFullName}}` and `{{defaultBranch}}` resolved. */
export function getTemplateFiles(id: TemplateId, vars: TemplateVars): Array<{ path: string; content: string }> {
  const values: Record<string, string> = { repoFullName: vars.repoFullName, defaultBranch: vars.defaultBranch };
  return rawTemplateFiles(id)
    .filter((file) => file.path !== 'template.json' && file.path !== 'onboarding.md')
    .map((file) => ({
      path: file.path,
      content: file.content.replace(/\{\{(repoFullName|defaultBranch)\}\}/g, (_m, key: string) => values[key]!),
    }));
}

/**
 * The full onboarding of one template: its own steps, then the generic setup
 * guide with the template chosen. `kortix templates onboard <id>` prints it and
 * the web serves it (`/factory.md` for the Software Factory), so both say the same.
 */
export function composeTemplateOnboarding(id: TemplateId, setupGuide: string): string {
  const template = getTemplate(id);
  const own = getTemplateOnboarding(id);
  return [
    `# Set up the Kortix ${template.name}`,
    '',
    template.summary,
    '',
    `The template is chosen: \`${template.id}\`. In step 3 of the guide below, offer only its loops. In step 4,`,
    `add only this one (\`kortix templates add ${template.id} --json\`) and adapt it.`,
    'Every **Ask** in the steps below is a question for the one message of guide step 3, with its',
    'recommended answer. Never ask it where it appears.',
    '',
    ...(own ? [own.trim(), ''] : []),
    setupGuide,
  ].join('\n');
}
