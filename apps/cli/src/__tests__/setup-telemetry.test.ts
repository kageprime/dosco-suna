import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeSetupRun, codingAgent, startSetupRun, telemetryOff } from '../setup-telemetry.ts';

test('codingAgent reads AI_AGENT first, then each tool marker, and a Kortix session wins', () => {
  expect(codingAgent({ AI_AGENT: 'claude-code_2-1-325_agent', CLAUDECODE: '1' })).toBe('claude_code');
  expect(codingAgent({ AI_AGENT: 'codex_0.50_agent' })).toBe('codex');
  expect(codingAgent({ AI_AGENT: 'github-copilot' })).toBe('copilot');
  expect(codingAgent({ AI_AGENT: 'something-new' })).toBe('other');
  expect(codingAgent({ CLAUDECODE: '1' })).toBe('claude_code');
  expect(codingAgent({ CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
  expect(codingAgent({ CURSOR_AGENT: '1' })).toBe('cursor');
  expect(codingAgent({ GEMINI_CLI: '1' })).toBe('gemini');
  expect(codingAgent({})).toBe('none');
  expect(codingAgent({ KORTIX_SUPERVISED: '1', AI_AGENT: 'claude-code' })).toBe('kortix');
});

test('telemetryOff honors DO_NOT_TRACK and KORTIX_TELEMETRY', () => {
  expect(telemetryOff({})).toBe(false);
  expect(telemetryOff({ DO_NOT_TRACK: '1' })).toBe(true);
  expect(telemetryOff({ DO_NOT_TRACK: 'true' })).toBe(true);
  expect(telemetryOff({ KORTIX_TELEMETRY: 'off' })).toBe(true);
  expect(telemetryOff({ KORTIX_TELEMETRY: '1' })).toBe(false);
});

test('a setup run lasts 24 hours after its last event; a corrupt file starts a new one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-setup-run-'));
  const file = join(dir, 'setup-run.json');
  try {
    const t0 = 1_000_000_000_000;
    expect(activeSetupRun(t0, file)).toBeNull();
    const run = startSetupRun(t0, file);
    expect(startSetupRun(t0 + 23 * 3_600_000, file).id).toBe(run.id);
    expect(activeSetupRun(t0 + 23 * 3_600_000 + 60_000, file)?.id).toBe(run.id);
    expect(activeSetupRun(t0 + 48 * 3_600_000, file)).toBeNull();
    expect(startSetupRun(t0 + 48 * 3_600_000, file).id).not.toBe(run.id);
    writeFileSync(file, '{not json');
    expect(activeSetupRun(t0, file)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
