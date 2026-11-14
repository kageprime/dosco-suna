import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTemplate } from '@kortix/starter/templates';
import { doctorExitCode, templateTriggerSlugs } from '../commands/templates-doctor.ts';

// `kortix templates doctor` is the onboarding's finish line: red while any
// check fails, green only when every line is green or a warning.
let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test('any red line exits 1; warnings alone exit 0', () => {
  expect(doctorExitCode([{ name: 'a', state: 'ok', detail: '' }, { name: 'b', state: 'warn', detail: '' }])).toBe(0);
  expect(doctorExitCode([{ name: 'a', state: 'ok', detail: '' }, { name: 'b', state: 'fail', detail: '' }])).toBe(1);
});

test('trigger slugs come from every YAML under the template folder, nested ones included', () => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-doctor-'));
  const template = getTemplate('software-factory');
  mkdirSync(join(dir, template.import_path, 'more'), { recursive: true });
  writeFileSync(join(dir, template.import_path, 'a.yaml'), 'triggers:\n  - slug: one\n    on: { cron: "0 0 1 * * *" }\n');
  writeFileSync(join(dir, template.import_path, 'more', 'b.yml'), 'triggers:\n  - slug: two\n');
  writeFileSync(join(dir, template.import_path, 'notes.md'), 'triggers: not yaml');
  expect(templateTriggerSlugs(dir, template).sort()).toEqual(['one', 'two']);
  expect(templateTriggerSlugs(join(dir, 'missing'), template)).toEqual([]);
});
