import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, readWorkflow } from '../src/fixtures/repo';

// rustc 1.100 (2026-11-09) broke the `screenshots` crate (E0277 `!: ReadAll`)
// and failed the Linux deb. Capture CI must install one pinned toolchain.
describe('capture-build.yml pins the Rust toolchain', () => {
  const source = readWorkflow('capture-build.yml');
  const installs = source.match(/rustup toolchain install .*/g) ?? [];
  const defaults = source.match(/rustup default .*/g) ?? [];

  it('declares one exact RUST_TOOLCHAIN version', () => {
    expect(source).toMatch(/^ {2}RUST_TOOLCHAIN: \d+\.\d+\.\d+$/m);
  });

  it('installs and defaults to the pin in every Rust job, never a floating channel', () => {
    expect(installs.length).toBeGreaterThan(0);
    expect(defaults).toHaveLength(installs.length);
    for (const line of installs) expect(line).toMatch(/^rustup toolchain install "\$RUST_TOOLCHAIN" /);
    for (const line of defaults) expect(line).toBe('rustup default "$RUST_TOOLCHAIN"');
    expect(source).not.toMatch(/rustup (toolchain install|default) (stable|beta|nightly)/);
  });
});

// Executable check: compile the crate that rustc 1.100 broke, `screenshots`
// (exact version in apps/capture/Cargo.lock), with the pinned toolchain.
// Needs rustup and network; skipped where rustup is absent.
const hasRustup = spawnSync('rustup', ['--version']).status === 0;
describe.skipIf(!hasRustup)('the pinned Rust toolchain compiles the screenshots crate', () => {
  it('cargo check passes on RUST_TOOLCHAIN', () => {
    const pin = readWorkflow('capture-build.yml').match(/^ {2}RUST_TOOLCHAIN: (\d+\.\d+\.\d+)$/m)?.[1] ?? '';
    const lock = readRepoFile('apps/capture/Cargo.lock');
    const version = lock.match(/name = "screenshots"\nversion = "([^"]+)"/)?.[1] ?? '';
    const dir = mkdtempSync(join(tmpdir(), 'capture-rust-pin-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/main.rs'), 'fn main() {}\n');
      writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\n[dependencies]\nscreenshots = "=${version}"\n`);
      const install = spawnSync('rustup', ['toolchain', 'install', pin, '--profile', 'minimal', '--no-self-update'], { encoding: 'utf8' });
      expect(install.status, install.stderr).toBe(0);
      const check = spawnSync('rustup', ['run', pin, 'cargo', 'check', '--manifest-path', join(dir, 'Cargo.toml')], { encoding: 'utf8' });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
