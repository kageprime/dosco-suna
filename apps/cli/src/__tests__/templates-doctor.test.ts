import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTemplate } from '@kortix/starter/templates';
import { doctorExitCode, legacyTemplateFolder, templateTriggerSlugs } from '../commands/templates-doctor.ts';

// `kortix templates doctor` is the onboarding's finish line: red while any
// check fails, green only when every line is green or a warning.
let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test('any red line exits 1; warnings alone exit 0', () => {
  expect(doctorExitCode([{ name: 'a', state: 'ok', detail: '' }, { name: 'b', state: 'warn', detail: '' }])).toBe(0);
  expect(doctorExitCode([{ name: 'a', state: 'ok', detail: '' }, { name: 'b', state: 'fail', detail: '' }])).toBe(1);
});

test('trigger slugs come from the template\'s import file at the root; the old .kortix/<id>/ folder is reported', () => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-doctor-'));
  const template = getTemplate('software-factory');
  writeFileSync(join(dir, template.import_path), 'triggers:\n  - slug: one\n    on: { cron: "0 0 1 * * *" }\n  - slug: two\n');
  expect(templateTriggerSlugs(dir, template).sort()).toEqual(['one', 'two']);
  expect(templateTriggerSlugs(join(dir, 'missing'), template)).toEqual([]);
  expect(legacyTemplateFolder(dir, template)).toBeNull();
  mkdirSync(join(dir, '.kortix', 'software-factory'), { recursive: true });
  expect(legacyTemplateFolder(dir, template)).toBe('.kortix/software-factory/');
});
