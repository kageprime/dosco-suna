import { describe, expect, test } from 'bun:test';
import { validateScopeForOperation } from './permission-checker';

describe('tunnel permission scope enforcement', () => {
  test('requires path boundaries instead of string prefixes', () => {
    expect(
      validateScopeForOperation(
        'filesystem',
        { paths: ['/home/user/project'], operations: ['read'] },
        'read',
        { path: '/home/user/project-other/secret.txt' },
      ).allowed,
    ).toBe(false);
    expect(
      validateScopeForOperation(
        'filesystem',
        { paths: ['/home/user/project'], operations: ['read'] },
        'read',
        { path: '/home/user/project/readme.md' },
      ).allowed,
    ).toBe(true);
  });

  test('handles Windows path boundaries on a non-Windows API host', () => {
    expect(
      validateScopeForOperation(
        'filesystem',
        { paths: ['C:\\Users\\Alice\\Project'], operations: ['read'] },
        'read',
        { path: 'C:\\Users\\Alice\\Project2\\secret.txt' },
      ).allowed,
    ).toBe(false);
    expect(
      validateScopeForOperation(
        'filesystem',
        { paths: ['C:\\Users\\Alice\\Project'], operations: ['read'] },
        'read',
        { path: 'c:\\users\\alice\\project\\readme.md' },
      ).allowed,
    ).toBe(true);
  });

  test('enforces shell working directories and timeout ceilings', () => {
    const scope = { commands: ['node'], workingDir: '/srv/project', maxTimeout: 1_000 };
    expect(
      validateScopeForOperation('shell', scope, 'exec', {
        command: 'node',
        cwd: '/srv/project-other',
        timeout: 500,
      }).allowed,
    ).toBe(false);
    expect(
      validateScopeForOperation('shell', scope, 'exec', {
        command: 'node',
        cwd: '/srv/project',
        timeout: 1_001,
      }).allowed,
    ).toBe(false);
  });

  test('matches the exact shell executable instead of a whitespace prefix', () => {
    expect(
      validateScopeForOperation('shell', { commands: ['/Applications/Tool Bin/tool'] }, 'exec', {
        command: '/Applications/Tool Bin/tool',
      }).allowed,
    ).toBe(true);
    expect(
      validateScopeForOperation('shell', { commands: ['node'] }, 'exec', {
        command: 'node --eval',
      }).allowed,
    ).toBe(false);
  });

  test('a shell allow list matches the whole command line, not the executable name', () => {
    const allowed = (commands: string[], command: string, args?: unknown) =>
      validateScopeForOperation('shell', { commands }, 'exec', { command, args }).allowed;
    // GHSA-j7fw-xwjq-c93q / GHSA-vh8g-gjv8-63v3: interpreter and LOLBin flags.
    expect(allowed(['node'], 'node', ['-e', 'process.exit(7)'])).toBe(false);
    expect(allowed(['git'], 'git', ['-c', 'alias.x=!touch /tmp/x', 'x'])).toBe(false);
    expect(allowed(['git status'], 'git', ['status', '-c', 'core.fsmonitor=x'])).toBe(false);
    expect(allowed(['git status'], 'git', ['status --short'])).toBe(false);
    expect(allowed(['node'], 'node', 'not-an-array')).toBe(false);
    expect(allowed(['node'], '', [])).toBe(false);
    expect(allowed(['node'], 'node', [])).toBe(true);
    expect(allowed(['git status'], 'git', ['status'])).toBe(true);
    expect(allowed(['git *'], 'git', ['-c', 'core.pager=x', 'log'])).toBe(true);
    expect(allowed(['npm run *'], 'npm', ['run', 'build'])).toBe(true);
    expect(allowed(['npm run *'], 'npm', ['exec', 'x'])).toBe(false);
    // No `commands` field is the unrestricted shell grant pairing mints.
    expect(
      validateScopeForOperation('shell', { scope: 'shell:exec' }, 'exec', {
        command: 'sh',
        args: ['-c', 'true'],
      }).allowed,
    ).toBe(true);
  });

  test('checks write size in bytes', () => {
    expect(
      validateScopeForOperation(
        'filesystem',
        { operations: ['write'], maxFileSize: 3 },
        'write',
        { path: '/tmp/file', content: 'éé' },
      ).allowed,
    ).toBe(false);
  });
});
