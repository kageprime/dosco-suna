import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const RULE_TITLE = 'Deeper, not bigger';
const RULE_HEADING = 'Deeper, not bigger. This is the most important rule.';
const CANONICAL_SKILL = '.agents/skills/driving-rule/SKILL.md';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', '.next', 'dist', 'build', 'target']);

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function collectFiles(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, predicate, out);
    else if (entry.isFile() && predicate(entry.name)) out.push(full);
  }
  return out;
}

function repoRel(file: string): string {
  return relative(REPO_ROOT, file).replaceAll('\\', '/');
}

describe('driving rule', () => {
  test('canonical rule is first in root AGENTS.md', () => {
    const root = read('AGENTS.md');
    expect(root).toContain(`# Dosco project`);
    expect(root).toContain(`## ${RULE_HEADING}`);
    expect(root).toContain(`Canonical skill: \`${CANONICAL_SKILL}\`.`);
    expect(root.indexOf(`## ${RULE_HEADING}`)).toBeLessThan(root.indexOf('## What "ownership" means'));
  });

  test('canonical skill exists and preserves required order', () => {
    expect(existsSync(join(REPO_ROOT, CANONICAL_SKILL))).toBe(true);
    const skill = read(CANONICAL_SKILL);
    expect(skill).toContain(`# ${RULE_TITLE}`);
    expect(skill).toContain('**Top professional.**');
    expect(skill).toContain('**Rawest material.**');
    expect(skill).toContain('**Specific methods and tools.**');
    expect(skill).toContain('**Independent proof.**');
    expect(skill).toContain('**Rewritten prompt.**');
    expect(skill).toContain('Deeper does not mean bigger.');
  });

  test('every AGENTS.md references the rule', () => {
    const files = collectFiles(REPO_ROOT, (name) => name === 'AGENTS.md');
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const rel = repoRel(file);
      const text = readFileSync(file, 'utf8');
      expect(text.includes(RULE_TITLE) || rel === 'AGENTS.md', rel).toBe(true);
      if (rel !== 'AGENTS.md') expect(text, rel).toContain(CANONICAL_SKILL);
    }
  });

  test('every SKILL.md references the rule', () => {
    const listed = Bun.spawnSync(['git', 'ls-files', '-c', '-o', '--exclude-standard', '--', '*SKILL.md'], { cwd: REPO_ROOT });
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((rel) => join(REPO_ROOT, rel));
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const rel = repoRel(file);
      const text = readFileSync(file, 'utf8');
      expect(text, rel).toContain(RULE_TITLE);
    }
  });

  test('CLAUDE.md files remain pointers to AGENTS.md', () => {
    const files = collectFiles(REPO_ROOT, (name) => name === 'CLAUDE.md');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), repoRel(file)).toContain('AGENTS.md');
    }
  });

  test('PR and contributor guidance reference the rule', () => {
    expect(read('.github/pull_request_template.md')).toContain(RULE_TITLE);
    expect(read('CONTRIBUTING.md')).toContain(RULE_TITLE);
  });
});
