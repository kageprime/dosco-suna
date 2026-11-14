import { describe, expect, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';
import { getTemplate, getTemplateFiles, listTemplates, TEMPLATE_IDS } from './templates';
import embedded from './embedded.generated.json' with { type: 'json' };

// Every hand-approved template is complete: metadata, an importable folder
// that holds only collections, and no placeholder left after rendering.
const IMPORTABLE = new Set(['agents', 'apps', 'tools', 'skills', 'commands', 'extensions', 'triggers', 'connectors', 'imports']);

describe('templates', () => {
  test('every id has its metadata and the compiled snapshot carries its files', () => {
    expect(listTemplates().map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    for (const id of TEMPLATE_IDS) {
      const t = getTemplate(id);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.summary.split(/\s+/).length).toBeLessThanOrEqual(30);
      expect(t.import_path).toBe(`.kortix/${id}/`);
      expect((embedded as Record<string, { files: unknown[] }>)[`template:${id}`]?.files.length).toBeGreaterThan(1);
    }
  });

  test('rendered files sit under .kortix/<id>/, resolve every placeholder, and import only collections', () => {
    for (const id of TEMPLATE_IDS) {
      const files = getTemplateFiles(id, { repoFullName: 'acme/shop', defaultBranch: 'main' });
      const triggers = new Set<string>();
      for (const file of files) {
        expect(file.path.startsWith(`.kortix/${id}/`)).toBe(true);
        expect(file.content).not.toMatch(/\{\{(repoFullName|defaultBranch)\}\}/);
        if (!/\.ya?ml$/.test(file.path)) continue;
        const doc = parseManifestText(file.content) as Record<string, unknown>;
        for (const key of Object.keys(doc)) expect(IMPORTABLE.has(key)).toBe(true);
        const agents = new Set(Object.keys((doc.agents as object) ?? {}));
        for (const trigger of (doc.triggers as Array<{ slug: string; run: { agent: string } }>) ?? []) {
          triggers.add(trigger.slug);
          // validate does not check that a trigger names a declared agent; this does.
          expect(agents.has(trigger.run.agent)).toBe(true);
        }
      }
      for (const hook of getTemplate(id).github_webhooks) expect(triggers.has(hook.trigger)).toBe(true);
    }
  });

  test('every webhook secret is a template secret, and every registered skill is a SKILL.md that names itself', () => {
    for (const id of TEMPLATE_IDS) {
      const files = getTemplateFiles(id, { repoFullName: 'acme/shop', defaultBranch: 'main' });
      const byPath = new Map(files.map((file) => [file.path, file.content]));
      const secrets = new Set(getTemplate(id).secrets.map((secret) => secret.name));
      for (const file of files) {
        if (!/\.ya?ml$/.test(file.path)) continue;
        const doc = parseManifestText(file.content) as {
          skills?: Record<string, string>;
          triggers?: Array<{ slug: string; on?: { webhook?: { secret?: string } } }>;
        };
        for (const trigger of doc.triggers ?? []) {
          const secret = trigger.on?.webhook?.secret;
          if (secret) expect({ trigger: trigger.slug, declared: secrets.has(secret) }).toEqual({ trigger: trigger.slug, declared: true });
        }
        for (const [name, folder] of Object.entries(doc.skills ?? {})) {
          const skill = byPath.get(`${folder.replace(/\/$/, '')}/SKILL.md`);
          expect({ skill: name, found: skill !== undefined }).toEqual({ skill: name, found: true });
          const frontmatter = Bun.YAML.parse(skill!.split('---')[1]!) as { name: string; description: string };
          expect(frontmatter.name).toBe(name);
          expect(frontmatter.description.length).toBeGreaterThan(20);
        }
      }
    }
  });
});
