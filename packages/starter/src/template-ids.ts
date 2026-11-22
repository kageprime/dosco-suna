/**
 * The hand-approved templates: each one a folder under `templates/<id>/` with
 * a `template.json`, its `<id>.yaml` (which a repository's `kortix.yaml`
 * imports), and its `agents/` and `skills/` files at the repository root. Adding a template is adding its folder and its id here.
 * This file imports nothing, so `scripts/generate-embedded.ts` can read it.
 */
export const TEMPLATE_IDS = ['software-factory', 'marketing', 'sales', 'recruiting', 'support'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
