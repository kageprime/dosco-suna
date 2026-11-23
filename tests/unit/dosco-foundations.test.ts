/**
 * Dosco Foundations Guard
 *
 * Data-driven gate over .agents/skills/dosco-foundations/references/foundations.json.
 * Every row is a Dosco decision that must survive an upstream merge or pull.
 * Add a row in the same PR that introduces the decision.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const registry = JSON.parse(
  readFileSync(
    join(REPO_ROOT, '.agents', 'skills', 'dosco-foundations', 'references', 'foundations.json'),
    'utf8',
  ),
) as {
  version: number;
  foundations: Array<{
    id: string;
    name: string;
    status: string;
    surface: string;
    check: Record<string, unknown>;
  }>;
};

type Check = {
  type: string;
  path?: string;
  text?: string;
  also?: string[];
  sha256?: string;
};

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function collectFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__snapshots__' || entry.name === 'node_modules') continue;
      collectFiles(full, out);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function runCheck(check: Check): void {
  const rel = check.path ?? '';
  switch (check.type) {
    case 'file-exists':
      expect(existsSync(join(REPO_ROOT, rel))).toBe(true);
      return;
    case 'file-absent':
      expect(existsSync(join(REPO_ROOT, rel))).toBe(false);
      return;
    case 'contains':
      expect(read(rel)).toContain(check.text ?? '');
      return;
    case 'excludes':
      expect(read(rel)).not.toContain(check.text ?? '');
      return;
    case 'excludes-tree': {
      const hits: string[] = [];
      for (const dir of [rel, ...(check.also ?? [])]) {
        for (const file of collectFiles(join(REPO_ROOT, dir))) {
          if (readFileSync(file, 'utf8').includes(check.text ?? '')) hits.push(file);
        }
      }
      expect(hits).toEqual([]);
      return;
    }
    case 'sha256': {
      const normalized = read(rel).split('\r\n').join('\n');
      expect(createHash('sha256').update(normalized).digest('hex')).toBe(check.sha256);
      return;
    }
    default:
      throw new Error(`unknown foundation check type: ${check.type}`);
  }
}

describe('Dosco foundations guard', () => {
  for (const foundation of registry.foundations) {
    test(`${foundation.id} — ${foundation.name}`, () => {
      runCheck(foundation.check as Check);
    });
  }
});
