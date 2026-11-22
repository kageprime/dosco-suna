// ─────────────────────────────────────────────────────────────────────────────
// Guided-setup milestones, for product analytics.
//
// /setup.md walks a coding agent through `kortix plan` → `kortix templates add`
// → `kortix onboard` → `kortix doctor --loops`. Each of those reports one event
// to POST /v1/cli/setup-events, and the API sends it to PostHog as the person
// whose token the CLI holds (apps/api/src/cli/setup-events.ts). That gives the
// funnel: how many setups start, where they stop, which coding agent ran them,
// and how long they took.
//
// - One setup run: `kortix plan` starts it; the id lives in setup-run.json next
//   to the CLI config and ends 24 hours after its last event. The other
//   commands report only inside a run, so an `onboard` outside a guided setup
//   sends nothing.
// - Only kinds, counts, durations and our own ids: never a repository, secret,
//   channel or connector name.
// - Off with DO_NOT_TRACK=1 or KORTIX_TELEMETRY=0. Never throws, never prints,
//   and waits at most 2 seconds.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApiClient } from './api/client.ts';
import { configFilePath } from './api/config.ts';
import { resolveProjectAuth } from './command-helpers.ts';
import { cliVersion } from './tui-bin.ts';

export type CodingAgent = 'claude_code' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'copilot' | 'kortix' | 'other' | 'none';

export type SetupEvent = 'setup_started' | 'setup_template_added' | 'setup_onboard_run' | 'setup_ready';

const RUN_WINDOW_MS = 24 * 60 * 60_000;
const SEND_TIMEOUT_MS = 2_000;

interface SetupRun {
  id: string;
  started_at: number;
  last_at: number;
  ready?: boolean;
}

interface Credential {
  api_base: string;
  token: string;
}

/**
 * The coding agent this process runs under, from the variables each one sets.
 * `AI_AGENT` is the shared convention (Claude Code sets it, as
 * `claude-code_<version>_agent`); the others are each tool's own marker.
 */
export function codingAgent(env: NodeJS.ProcessEnv = process.env): CodingAgent {
  if ((env.KORTIX_SUPERVISED ?? '').trim() === '1' || env.KORTIX_SESSION_ID) return 'kortix';
  const named = (env.AI_AGENT ?? '').trim().toLowerCase();
  if (named) {
    if (named.startsWith('claude')) return 'claude_code';
    if (named.startsWith('codex')) return 'codex';
    if (named.startsWith('cursor')) return 'cursor';
    if (named.startsWith('gemini')) return 'gemini';
    if (named.startsWith('opencode')) return 'opencode';
    if (named.includes('copilot')) return 'copilot';
    return 'other';
  }
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude_code';
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM) return 'codex';
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor';
  if (env.GEMINI_CLI) return 'gemini';
  if (env.OPENCODE) return 'opencode';
  return 'none';
}

/** The credential this command uses (the folder's linked host, else the active one), or null. */
export function currentCredential(): Credential | null {
  try {
    const { auth } = resolveProjectAuth();
    return auth?.token ? { api_base: auth.api_base, token: auth.token } : null;
  } catch {
    return null;
  }
}

/** True when the person turned telemetry off. */
export function telemetryOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const dnt = (env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  const kortix = (env.KORTIX_TELEMETRY ?? '').trim().toLowerCase();
  return dnt === '1' || dnt === 'true' || kortix === '0' || kortix === 'false' || kortix === 'off';
}

function runFile(): string {
  return resolve(dirname(configFilePath()), 'setup-run.json');
}

function readRun(file: string, now: number): SetupRun | null {
  try {
    if (!existsSync(file)) return null;
    const run = JSON.parse(readFileSync(file, 'utf8')) as Partial<SetupRun>;
    if (typeof run.id !== 'string' || typeof run.started_at !== 'number' || typeof run.last_at !== 'number') return null;
    if (now - run.last_at > RUN_WINDOW_MS) return null;
    return run as SetupRun;
  } catch {
    return null;
  }
}

function writeRun(file: string, run: SetupRun): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  } catch {
    // A read-only home loses the link between events, never the command.
  }
}

/** The active run, or a new one: `kortix plan` calls this. */
export function startSetupRun(now = Date.now(), file = runFile()): SetupRun {
  const run = readRun(file, now) ?? { id: randomUUID(), started_at: now, last_at: now };
  run.last_at = now;
  writeRun(file, run);
  return run;
}

/** The active run, or null outside a guided setup. */
export function activeSetupRun(now = Date.now(), file = runFile()): SetupRun | null {
  return readRun(file, now);
}

function versionLabel(): string {
  const version = cliVersion();
  return /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : 'unknown';
}

async function send(credential: Credential | null | undefined, event: SetupEvent, run: SetupRun, properties: object): Promise<void> {
  if (!credential?.token || telemetryOff()) return;
  try {
    // The SDK client sends the token and the X-Kortix-Client-Version header.
    await createApiClient({ apiBase: credential.api_base, token: credential.token, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
      .post('/cli/setup-events', { event, setup_id: run.id, agent: codingAgent(), cli_version: versionLabel(), properties });
  } catch {
    // Telemetry never fails a command.
  }
}

/** `kortix plan`: a guided setup starts, or continues within 24 hours. */
export async function reportSetupStarted(credential: Credential | null | undefined, props: { has_workspace: boolean; has_manifest: boolean }): Promise<void> {
  if (!credential?.token || telemetryOff()) return;
  await send(credential, 'setup_started', startSetupRun(), props);
}

/** `kortix templates add <id>` inside a run. */
export async function reportTemplateAdded(credential: Credential | null | undefined, template: string): Promise<void> {
  const run = activeSetupRun();
  if (!run) return;
  writeRun(runFile(), { ...run, last_at: Date.now() });
  await send(credential, 'setup_template_added', run, { template });
}

export interface OnboardRunProps {
  project_id: string | null;
  exit_code: number;
  wait: boolean;
  waited_s: number;
  duration_s: number;
  steps_left: number;
  connectors: number;
  secrets: number;
  sandbox_templates: number;
  slack: boolean;
  phases: Record<string, string>;
}

/** Each `kortix onboard` inside a run. */
export async function reportOnboardRun(credential: Credential | null | undefined, props: OnboardRunProps): Promise<void> {
  const run = activeSetupRun();
  if (!run) return;
  writeRun(runFile(), { ...run, last_at: Date.now() });
  await send(credential, 'setup_onboard_run', run, props);
}

/** The first green onboard or `kortix doctor --loops` inside a run. Once per run. */
export async function reportSetupReady(credential: Credential | null | undefined, props: { project_id: string | null; via: 'onboard' | 'doctor' }): Promise<void> {
  const now = Date.now();
  const run = activeSetupRun(now);
  if (!run || run.ready) return;
  writeRun(runFile(), { ...run, last_at: now, ready: true });
  await send(credential, 'setup_ready', run, { ...props, minutes_since_start: Math.round(((now - run.started_at) / 60_000) * 10) / 10 });
}
