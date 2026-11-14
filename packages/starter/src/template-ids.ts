/**
 * The hand-approved templates: each one a folder under `templates/<id>/` with
 * a `template.json` and a `.kortix/<id>/` tree that a repository imports from
 * its `kortix.yaml`. Adding a template is adding its folder and its id here.
 * This file imports nothing, so `scripts/generate-embedded.ts` can read it.
 */
export const TEMPLATE_IDS = ['software-factory', 'marketing', 'sales', 'recruiting', 'support'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
