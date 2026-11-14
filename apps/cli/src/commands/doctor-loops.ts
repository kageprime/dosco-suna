/**
 * `kortix doctor --loops [--fix]` — the green/red list of what this
 * repository's kortix.yaml declares (see onboarding/loops-doctor.ts). With
 * --fix, each red line that names a phase re-runs that onboarding phase
 * (ship, secrets, webhooks, Slack, connectors, sandbox build), then the list
 * is read again.
 */
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { type Check, doctorExitCode, type FixPhase } from '../onboarding/loops-doctor.ts';
import {
  type OnboardState,
  type PhaseResult,
  phaseConnectors,
  phaseSandbox,
  phaseSecrets,
  phaseShip,
  phaseSlack,
  phaseWebhooks,
  timed,
} from '../onboarding/phases.ts';
import { C, help, status } from '../style.ts';
import { doctorChecks, loadLoopsState } from './onboard.ts';

export const LOOPS_HELP = help`Usage: kortix doctor --loops [--fix] [options]

One green/red list for what this repository's kortix.yaml (with its imports)
declares: manifest valid, workspace linked, every referenced secret set,
triggers live, sandbox images built, GitHub webhooks (and labels) in place
for GitHub-filtered webhook triggers, connectors and Slack connected, a model
that answers, and the API's public URL when it runs behind a
*.trycloudflare.com quick tunnel.

Options:
  --fix                Re-run the onboarding phase for each red line that has
                       one: absent triggers → ship, unset webhook secret →
                       generate, missing or stale webhook → create/update,
                       label missing → create, image not built → build + wait,
                       Slack or a connector not connected → a sign-in link.
  --repo <owner/repo>  The GitHub repository of the webhooks (default: origin).
  --build-timeout <s>  --fix: how long to wait for each image (default 1800).
  --json               Print JSON: { ready, checks, fixed, user_actions }.
  -h, --help           Show this help.

Exit 0 when every line is green or a warning; 1 while any line is red.
`;

const FIX_ORDER: FixPhase[] = ['ship', 'secrets', 'webhooks', 'slack', 'connectors', 'sandbox'];
const PHASE_FN: Record<FixPhase, (state: OnboardState) => ReturnType<typeof phaseShip>> = {
  ship: phaseShip,
  secrets: phaseSecrets,
  webhooks: phaseWebhooks,
  slack: phaseSlack,
  connectors: phaseConnectors,
  sandbox: phaseSandbox,
};

function printChecks(checks: Check[]): void {
  for (const check of checks) {
    const line = `${check.name}: ${check.detail}`;
    process.stdout.write(`${check.state === 'ok' ? status.ok(line) : check.state === 'warn' ? status.warn(line) : status.err(line)}\n`);
    if (check.fix && check.state !== 'ok') process.stdout.write(`       ${C.dim}fix: ${check.fix}${C.reset}\n`);
  }
}

/** Run the phases the red lines name, once each, in onboarding order. */
export async function fixChecks(state: OnboardState, checks: Check[]): Promise<PhaseResult[]> {
  const wanted = new Set(checks.filter((c) => c.state === 'fail' && c.phase).map((c) => c.phase!));
  // Webhooks need the secret they sign with, generated in the same run.
  if (wanted.has('webhooks') || wanted.has('secrets')) {
    wanted.add('secrets');
    if (state.needs.github_webhooks.length) wanted.add('webhooks');
  }
  const fixed: PhaseResult[] = [];
  for (const phase of FIX_ORDER) {
    if (!wanted.has(phase)) continue;
    if (phase !== 'ship' && !state.ctx) break;
    fixed.push(await timed(phase, () => PHASE_FN[phase](state)));
  }
  return fixed;
}

export async function runLoopsDoctor(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, LOOPS_HELP, (rest) => ({
    fix: takeFlagBool(rest, ['--fix']),
    json: takeFlagBool(rest, ['--json']),
    repo: takeFlagValue(rest, ['--repo']),
    buildTimeout: Number(takeFlagValue(rest, ['--build-timeout']) ?? 1800),
  }));
  if (typeof flags === 'number') return flags;
  const { state, manifestFile } = await loadLoopsState({
    repo: flags.repo ?? null,
    options: { envFiles: [], allowRemote: false, channels: [], connect: [], githubToken: null, buildTimeoutSec: flags.buildTimeout, message: 'chore: add Kortix loops' },
  });
  let checks = await doctorChecks(state, manifestFile);
  let fixed: PhaseResult[] = [];
  if (flags.fix && doctorExitCode(checks) !== 0) {
    fixed = await fixChecks(state, checks);
    checks = await doctorChecks(state, manifestFile);
  }
  const code = doctorExitCode(checks);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ready: code === 0, checks, fixed, user_actions: state.actions }, null, 2)}\n`);
    return code;
  }
  process.stdout.write(`\n  ${C.bold}kortix doctor --loops${C.reset}\n\n`);
  for (const f of fixed) process.stdout.write(`  ${C.dim}fixed ${f.name}: ${f.status.replace(/_/g, ' ')} (${f.detail})${C.reset}\n`);
  if (fixed.length) process.stdout.write('\n');
  printChecks(checks);
  for (const action of state.actions) process.stdout.write(`  ${status.warn(`person: ${action.what}`)}${action.url ? ` ${C.cyan}${action.url}${C.reset}` : ''}\n`);
  process.stdout.write(`\n  ${code === 0 ? 'Ready.' : 'Not ready: fix the red lines (or run with --fix), then run this again.'}\n\n`);
  return code;
}
