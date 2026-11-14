/**
 * Lightweight structural validation for registry.json / registry-item.json.
 * Reports `@kortix/manifest-schema`'s issue model (a list of typed issues
 * with severities) so the CLI can render a consistent report.
 */

import type { ManifestIssue } from '@kortix/manifest-schema';
import { REGISTRY_NAME_RE } from '@kortix/manifest-schema/constants';
import { ALL_ITEM_TYPES, type RegistryItem, type RegistryJson, type RegistryItemType } from './schema';

export type ValidationIssue = ManifestIssue;

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function push(issues: ValidationIssue[], severity: ValidationIssue['severity'], path: string, message: string) {
  issues.push({ severity, path, message });
}

export function isRegistryItemType(value: unknown): value is RegistryItemType {
  return typeof value === 'string' && (ALL_ITEM_TYPES as readonly string[]).includes(value);
}

export function validateRegistryItem(item: unknown, basePath = 'item'): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    push(issues, 'error', basePath, 'item must be an object');
    return { valid: false, issues };
  }
  const it = item as Record<string, unknown>;

  if (typeof it.name !== 'string' || !it.name.trim()) {
    push(issues, 'error', `${basePath}.name`, 'name is required');
  } else if (!REGISTRY_NAME_RE.test(it.name)) {
    // agentskills.io spec: lowercase a-z/0-9 with single hyphens, no leading/
    // trailing/double hyphen. (Ingest stays lenient; this only warns on `validate`.)
    push(issues, 'warning', `${basePath}.name`, `"${it.name}" isn't a spec slug (lowercase a-z, 0-9, single hyphens)`);
  }

  if (!isRegistryItemType(it.type)) {
    push(issues, 'error', `${basePath}.type`, `type must be one of: ${ALL_ITEM_TYPES.join(', ')}`);
  }

  const files = it.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) {
      push(issues, 'error', `${basePath}.files`, 'files must be an array');
    } else {
      files.forEach((f, i) => {
        const fp = `${basePath}.files[${i}]`;
        if (!f || typeof f !== 'object') {
          push(issues, 'error', fp, 'file must be an object');
          return;
        }
        const file = f as Record<string, unknown>;
        const hasPath = typeof file.path === 'string' && file.path.trim().length > 0;
        const hasContent = typeof file.content === 'string';
        if (!hasPath && !hasContent) {
          push(issues, 'error', `${fp}.path`, 'file needs a path or inline content');
        }
        if (file.type !== undefined && !isRegistryItemType(file.type)) {
          push(issues, 'error', `${fp}.type`, 'file.type is not a valid registry type');
        }
        if (typeof file.target === 'string' && file.target.includes('..')) {
          push(issues, 'error', `${fp}.target`, 'target may not contain ".." segments');
        }
      });
    }
  }

  // An item with no files and no dependencies installs nothing — unless it is a
  // bundle (whose whole job is to pull `registryDependencies`).
  const hasFiles = Array.isArray(files) && files.length > 0;
  const hasDeps = Array.isArray(it.registryDependencies) && it.registryDependencies.length > 0;
  if (!hasFiles && !hasDeps && it.type !== 'registry:bundle') {
    push(issues, 'warning', basePath, 'item declares no files and no registryDependencies');
  }

  for (const key of ['dependencies', 'devDependencies', 'registryDependencies', 'categories']) {
    if (it[key] !== undefined && !Array.isArray(it[key])) {
      push(issues, 'error', `${basePath}.${key}`, `${key} must be an array`);
    }
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

export function validateRegistry(registry: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    push(issues, 'error', 'registry', 'registry.json must be an object');
    return { valid: false, issues };
  }
  const reg = registry as Record<string, unknown>;

  if (typeof reg.name !== 'string' || !reg.name.trim()) {
    push(issues, 'error', 'name', 'registry name is required');
  }

  const hasItems = Array.isArray(reg.items);
  const hasInclude = Array.isArray(reg.include);
  if (!hasItems && !hasInclude) {
    push(issues, 'error', 'items', 'registry must declare `items` or `include`');
  }

  if (reg.include !== undefined && !Array.isArray(reg.include)) {
    push(issues, 'error', 'include', 'include must be an array of paths');
  }

  const seen = new Set<string>();
  if (hasItems) {
    (reg.items as unknown[]).forEach((item, i) => {
      const res = validateRegistryItem(item, `items[${i}]`);
      issues.push(...res.issues);
      const name = (item as Record<string, unknown>)?.name;
      if (typeof name === 'string') {
        if (seen.has(name)) push(issues, 'error', `items[${i}].name`, `duplicate item name "${name}"`);
        seen.add(name);
      }
    });
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => `  ${i.severity === 'error' ? '✗' : '!'} ${i.path}: ${i.message}`)
    .join('\n');
}
