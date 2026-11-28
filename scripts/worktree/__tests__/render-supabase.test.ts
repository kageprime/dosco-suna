import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computePorts } from '../lib';
import { renderSupabaseProject } from '../lib/supabase';

const worktree = mkdtempSync(join(tmpdir(), 'wt-render-'));
const name = `render-test-${process.pid}`;
let workdir = '';
afterAll(() => {
  rmSync(worktree, { recursive: true, force: true });
  if (workdir) rmSync(dirname(workdir), { recursive: true, force: true });
});

test('a --full-supabase project links the email templates its config names', () => {
  mkdirSync(join(worktree, 'supabase', 'templates'), { recursive: true });
  writeFileSync(join(worktree, 'supabase', 'config.toml'), 'project_id = "x"\n');
  writeFileSync(
    join(worktree, 'supabase', 'templates', 'confirmation.html'),
    '<a href="{{ .RedirectTo }}">x</a>',
  );

  workdir = renderSupabaseProject(name, worktree, `kortix-wt-${name}`, computePorts(1));

  expect(readlinkSync(join(workdir, 'supabase', 'templates'))).toBe(
    join(worktree, 'supabase', 'templates'),
  );
});
