/**
 * `kortix onboard --yes` — make real whatever this repository's kortix.yaml
 * (with its imports) declares, in phases: validate, ship, secrets, GitHub
 * webhooks, Slack, connectors, sandbox images, then the loops doctor. Every
 * phase skips what is done, so running it again is the way to continue after
 * a person finished a user_action.
 *
 * Exit 0: done and the doctor is green. 4: done, but user_actions or doctor
 * lines remain. 1: a phase failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue, takeFlagValues } from '../command-helpers.ts';
import { runGit } from '../git-run.ts';
import { loadLocalManifest, resolveLocalManifest, validateManifestFile, formatIssueLine } from '../manifest.ts';
import { collectLoopChecks, doctorExitCode, type Check } from '../onboarding/loops-doctor.ts';
import { manifestNeeds, type ManifestNeeds } from '../onboarding/manifest-needs.ts';
import {
  type OnboardOptions,
  type OnboardState,
  type PhaseName,
  type PhaseResult,
  phaseConnectors,
  phaseSandbox,
  phaseSecrets,
  phaseShip,
  phaseSlack,
  phaseWebhooks,
  pendingSetup,
  resolveWorkspace,
  timed,
  type UserAction,
} from '../onboarding/phases.ts';
import { C, help, status } from '../style.ts';
import { currentCredential, reportOnboardRun, reportSetupReady } from '../setup-telemetry.ts';
import { channelList } from './channels-join.ts';
import { githubRepoFromRemote } from '../github-remote.ts';
import { openInBrowser } from '../browser.ts';
import { projectWebUrl } from '../web-url.ts';

const HELP = help`Usage: kortix onboard --yes [options]

Make this repository's kortix.yaml real on Kortix, in phases, each with a
status and a duration:

  validate    kortix.yaml and its imports pass kortix validate
  ship        link the workspace and push (GitHub App, or --github-token -)
  secrets     push approved env names, generate every unset webhook secret,
              one intake link for the secrets a person must paste
  webhooks    a repository webhook for each webhook trigger that filters on
              headers.github_event (created, or updated to the current URL),
              and the label a trigger filters on (body.label.name)
  slack       connect link when Slack is not connected; the bot joins
              --channels (a private channel becomes an /invite user_action)
  connectors  a sign-in link for each declared connector not connected
  sandbox     build every sandbox.templates image and wait until it is ready
  doctor      kortix doctor --loops

Every phase skips what is done: run it again after a person finished a
user_action. Without --yes it prints what it would do and changes nothing.

Options:
  --yes, -y                 Do it.
  --json                    Print JSON: { phases, user_actions, doctor, next }.
  --name <workspace>        Display name when this run creates the workspace
                            (default: project.name in kortix.yaml, else the
                            folder name).
  --repo <owner/repo>       The GitHub repository for the webhooks (default: a
                            trigger's body.repository.full_name filter, else
                            this repository's origin). Pass it when kortix.yaml
                            lives in its own repository.
  --env-file <file>         A dotenv file to push names from. Pair each with
    --only <A,B>            the names the person approved. A value is read in
                            this process only; prod-looking names are refused.
  --allow-remote            Also push approved names whose value is a URL on
                            another host (a shared backend).
  --channels <a,b>          Slack channels the bot joins (# optional).
  --connect <slug,...>      Also connect these connectors.
  --github-token -          Read a GitHub token from stdin for ship (no App).
  --build-timeout <sec>     How long to wait for each image (default 1800).
  --no-open                 Do not open the setup page in the browser.
  --wait                    When the person has steps left, wait until the
                            setup page shows them done, then finish the run.
  --wait-timeout <sec>      How long --wait waits (default 1800).
  -m, --message <msg>       Commit message when kortix.yaml changed
                            (default "chore: add Kortix loops").
  -h, --help                Show this help.

Exit codes: 0 done and doctor ready; 4 done, user_actions or doctor lines
left; 1 a phase failed; 2 bad arguments.
`;

const ORDER: PhaseName[] = ['validate', 'ship', 'secrets', 'webhooks', 'slack', 'connectors', 'sandbox'];

function gitRoot(): string {
  const top = runGit(undefined, ['rev-parse', '--show-toplevel']);
  return top.ok ? top.stdout.trim() : process.cwd();
}

export function originRepo(root: string): string | null {
  const remote = runGit(root, ['remote', 'get-url', 'origin']);
  return remote.ok ? githubRepoFromRemote(remote.stdout) : null;
}

/** The manifest, its needs and the workspace: what onboard and doctor --loops share. */
export async function loadLoopsState(opts: { repo?: string | null; options: OnboardOptions }): Promise<{ state: OnboardState; manifestFile: string | null; manifestError: string | null }> {
  const root = gitRoot();
  process.chdir(root);
  const manifestFile = resolveLocalManifest(root)?.path ?? null;
  let needs: ManifestNeeds = { secrets: [], triggers: [], github_webhooks: [], sandbox_templates: [], sandbox_default: null, connectors: [], uses_slack: false };
  let manifestError: string | null = null;
  if (manifestFile) {
    try {
      needs = manifestNeeds(loadLocalManifest(root)?.data ?? {}, root);
    } catch (err) {
      manifestError = (err as Error).message.split('\n')[0]!;
    }
  }
  const state: OnboardState = {
    root,
    needs,
    repo: opts.repo ?? originRepo(root),
    ctx: null,
    generated: new Map(),
    actions: [],
    opts: opts.options,
  };
  await resolveWorkspace(state);
  return { state, manifestFile, manifestError };
}

export async function doctorChecks(state: OnboardState, manifestFile: string | null): Promise<Check[]> {
  return collectLoopChecks({
    root: state.root,
    manifestFile,
    needs: state.needs,
    client: state.ctx?.client ?? null,
    projectId: state.ctx?.projectId ?? null,
    apiBase: state.ctx?.apiBase ?? null,
    repo: state.repo,
  });
}

/** Poll the setup page's steps until none is left or the time is up; the steps still open. */
async function waitForSetup(state: OnboardState, timeoutSec: number): Promise<Awaited<ReturnType<typeof pendingSetup>>> {
  const interval = Number(process.env.KORTIX_ONBOARD_POLL_MS) || 5000;
  const deadline = Date.now() + timeoutSec * 1000;
  let left = await pendingSetup(state);
  let shown = -1;
  while (left.length > 0 && Date.now() < deadline) {
    if (left.length !== shown) {
      process.stderr.write(`       ${C.dim}waiting:${C.reset} ${left.length} left on the setup page (${left.map((item) => item.name).join(', ')})\n`);
      shown = left.length;
    }
    await Bun.sleep(interval);
    left = await pendingSetup(state).catch(() => left);
  }
  return left;
}

function nextStep(phases: PhaseResult[], actions: UserAction[], ready: boolean, state: OnboardState, setupUrl: string | null): string {
  const failed = phases.find((p) => p.status === 'failed');
  if (failed) return `Fix the ${failed.name} phase (${failed.detail}), then run kortix onboard --yes --json again.`;
  if (setupUrl) return `The person finishes the steps on the setup page (${setupUrl}). Run kortix onboard --yes --json --wait: it waits until the page is done, then finishes. Hand any other user_action to the person.`;
  if (actions.length) return 'Hand each user_action to the person. When they are done, run kortix onboard --yes --json again: it skips what is done.';
  if (!ready) return 'Run kortix doctor --loops --fix --json, then fix each remaining red line by its fix.';
  const proof = state.needs.triggers.find((t) => t.enabled && !t.webhook);
  return proof ? `Ready. Prove one run: kortix triggers fire ${proof.slug} --wait 300s` : 'Ready.';
}

const MARK: Record<PhaseResult['status'], (s: string) => string> = {
  done: status.ok,
  skipped: (s) => `  ${C.dim}-${C.reset} ${s}`,
  waiting_on_person: status.warn,
  failed: status.err,
};

function phaseLine(p: PhaseResult): string {
  return MARK[p.status](`${p.name.padEnd(10)} ${p.status.replace(/_/g, ' ')}  ${C.dim}${p.detail} (${(p.duration_ms / 1000).toFixed(1)}s)${C.reset}`);
}

/** The user_actions the workspace's setup page shows; the others stay in the terminal. */
const SETUP_PAGE_KINDS = new Set<UserAction['kind']>(['connector_sign_in', 'secret_request', 'slack_install']);

/** Seconds the run before this one waited on the setup page: `--wait` finishes with a second pass. */
let carriedWaitS = 0;

export async function runOnboard(argv: string[]): Promise<number> {
  const original = [...argv];
  const runStarted = Date.now();
  let waitedS = carriedWaitS;
  carriedWaitS = 0;
  const flags = takeFlags(argv, HELP, (rest) => {
    const envPairs: Array<{ file: string; only: string[] }> = [];
    // `--env-file A --only X,Y --env-file B --only Z`: each --only belongs to the --env-file before it.
    for (let i = 0; i < rest.length; ) {
      if (rest[i] === '--env-file') {
        const file = rest[i + 1];
        if (!file || file.startsWith('-')) throw new Error('--env-file needs a file');
        const onlyAt = rest[i + 2] === '--only' ? rest[i + 3] : undefined;
        if (!onlyAt) throw new Error(`--env-file ${file} needs --only <A,B>: the names the person approved`);
        envPairs.push({ file, only: onlyAt.split(',').map((n) => n.trim()).filter(Boolean) });
        rest.splice(i, 4);
      } else i += 1;
    }
    const token = takeFlagValue(rest, ['--github-token']);
    if (token !== undefined && token !== '-') throw new Error('--github-token takes only - (read the token from stdin)');
    return {
      yes: takeFlagBool(rest, ['--yes', '-y']),
      json: takeFlagBool(rest, ['--json']),
      repo: takeFlagValue(rest, ['--repo']),
      name: takeFlagValue(rest, ['--name']),
      allowRemote: takeFlagBool(rest, ['--allow-remote']),
      channels: channelList(takeFlagValues(rest, ['--channels'])),
      connect: takeFlagValues(rest, ['--connect']).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean),
      tokenFromStdin: token === '-',
      buildTimeout: Number(takeFlagValue(rest, ['--build-timeout']) ?? 1800),
      open: !takeFlagBool(rest, ['--no-open']),
      wait: takeFlagBool(rest, ['--wait']),
      waitTimeout: Number(takeFlagValue(rest, ['--wait-timeout']) ?? 1800),
      message: takeFlagValue(rest, ['--message', '-m']) ?? 'chore: add Kortix loops',
      envPairs,
    };
  });
  if (typeof flags === 'number') return flags;
  if (!Number.isFinite(flags.waitTimeout) || flags.waitTimeout < 0) {
    process.stderr.write(`${status.err('--wait-timeout must be a number of seconds')}\n`);
    return 2;
  }
  if (!Number.isFinite(flags.buildTimeout) || flags.buildTimeout < 0) {
    process.stderr.write(`${status.err('--build-timeout must be a number of seconds')}\n`);
    return 2;
  }
  if (flags.repo && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) {
    process.stderr.write(`${status.err('--repo must be <owner>/<repo>')}\n`);
    return 2;
  }
  for (const pair of flags.envPairs) {
    if (!existsSync(resolve(gitRoot(), pair.file))) {
      process.stderr.write(`${status.err(`No env file ${pair.file}`)}\n`);
      return 2;
    }
  }
  const githubToken = flags.tokenFromStdin ? (await Bun.stdin.text()).trim() || null : null;
  if (flags.tokenFromStdin && !githubToken) {
    process.stderr.write(`${status.err('--github-token -: stdin was empty')}\n`);
    return 2;
  }

  const options: OnboardOptions = {
    envFiles: flags.envPairs,
    allowRemote: flags.allowRemote,
    channels: flags.channels,
    connect: flags.connect,
    githubToken,
    buildTimeoutSec: flags.buildTimeout,
    name: flags.name ?? null,
    message: flags.message,
  };
  const { state, manifestFile, manifestError } = await loadLoopsState({ repo: flags.repo ?? null, options });

  if (!flags.yes) {
    const would = {
      dry_run: true,
      manifest: manifestFile,
      workspace: state.ctx?.projectId ?? null,
      repo: state.repo,
      needs: state.needs,
      phases: ORDER,
      next: 'Agree this with the person, then run kortix onboard --yes --json.',
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(would, null, 2)}\n`);
    else {
      process.stdout.write(`\n  ${C.bold}kortix onboard${C.reset} ${C.dim}(dry run: pass --yes to do it)${C.reset}\n\n`);
      process.stdout.write(`  manifest   ${manifestFile ?? 'none'}\n  workspace  ${state.ctx?.projectId ?? 'none reachable (not linked, or not signed in): ship links or creates it'}\n  repo       ${state.repo ?? 'unknown'}\n`);
      process.stdout.write(`  secrets    ${state.needs.secrets.map((s) => s.name).join(', ') || 'none'}\n  webhooks   ${state.needs.github_webhooks.map((w) => w.slug).join(', ') || 'none'}\n`);
      process.stdout.write(`  sandbox    ${state.needs.sandbox_templates.join(', ') || 'none'}\n  connectors ${state.needs.connectors.map((c) => c.slug).join(', ') || 'none'}\n  slack      ${state.needs.uses_slack || options.channels.length ? 'yes' : 'no'}\n\n`);
    }
    return 0;
  }

  const phases: PhaseResult[] = [];
  const reported = new Set<UserAction>();
  const record = (result: PhaseResult) => {
    phases.push(result);
    // Progress goes to stderr: JSON on stdout stays one document, and a waiting agent sees links at once.
    process.stderr.write(`${phaseLine(result)}\n`);
    for (const action of state.actions) {
      if (reported.has(action)) continue;
      reported.add(action);
      process.stderr.write(`       ${C.dim}person:${C.reset} ${action.what}${action.url ? ` ${C.cyan}${action.url}${C.reset}` : ''}${action.command ? ` ${C.cyan}${action.command}${C.reset}` : ''}\n`);
    }
  };

  record(await timed('validate', async () => {
    if (!manifestFile) return { status: 'failed', detail: 'no kortix.yaml in this repository' };
    if (manifestError) return { status: 'failed', detail: manifestError };
    const errors = validateManifestFile(manifestFile).issues.filter((i) => i.severity === 'error');
    return errors.length ? { status: 'failed', detail: `${errors.length} errors: ${formatIssueLine(errors[0]!, state.root).trim()}` } : { status: 'done', detail: `${readFileSync(manifestFile, 'utf8').split('\n').length} lines, ${state.needs.triggers.length} triggers` };
  }));
  const blocked = (reason: string) => (name: PhaseName): PhaseResult => ({ name, status: 'skipped', duration_ms: 0, detail: reason });
  // Every sign-in, secret and Slack step on one page: the person clicks there, not in the terminal.
  // The server's own workspace URL (its FRONTEND_URL) first; a guess from the API host only without one.
  let workspaceUrl: string | null = null;
  const setupPageUrl = () =>
    state.ctx && workspaceUrl && state.actions.some((a) => SETUP_PAGE_KINDS.has(a.kind))
      ? `${workspaceUrl}/setup${state.opts.channels.length > 0 || state.needs.uses_slack ? '?slack=1' : ''}`
      : null;
  let announced = false;
  const announceSetupPage = async () => {
    if (state.ctx && !workspaceUrl) {
      const project = await state.ctx.client.get<{ dashboard_url?: string | null }>(`/workspaces/${state.ctx.projectId}`).catch(() => null);
      workspaceUrl = projectWebUrl(state.ctx.apiBase, state.ctx.projectId, project?.dashboard_url);
    }
    const url = setupPageUrl();
    if (!url || announced) return;
    announced = true;
    const opened = flags.open && !process.env.KORTIX_NO_BROWSER && openInBrowser(url);
    process.stderr.write(`       ${C.dim}person:${C.reset} ${opened ? 'the setup page is open in the browser' : 'open the setup page'}: ${C.cyan}${url}${C.reset}\n`);
  };

  if (phases[0]!.status === 'failed') {
    for (const name of ORDER.slice(1)) record(blocked('kortix.yaml is not valid')(name));
  } else {
    record(await timed('ship', () => phaseShip(state)));
    const ship = phases[1]!;
    // The later phases act on what ship pushed: they wait while it has not.
    if (!state.ctx || ship.status === 'failed' || ship.status === 'waiting_on_person') {
      for (const name of ORDER.slice(2)) record(blocked(ship.status === 'failed' ? 'ship failed' : ship.status === 'waiting_on_person' ? 'waits for ship' : 'no workspace')(name));
    } else {
      record(await timed('secrets', () => phaseSecrets(state)));
      record(await timed('webhooks', () => phaseWebhooks(state)));
      record(await timed('slack', () => phaseSlack(state)));
      record(await timed('connectors', () => phaseConnectors(state)));
      // The person works through the setup page while the image builds.
      await announceSetupPage();
      record(await timed('sandbox', () => phaseSandbox(state)));
    }
  }

  const started = Date.now();
  const checks = await doctorChecks(state, manifestFile);
  const ready = doctorExitCode(checks) === 0;
  record({ name: 'doctor', status: ready ? 'done' : 'waiting_on_person', duration_ms: Date.now() - started, detail: ready ? 'every line green' : `red: ${checks.filter((c) => c.state === 'fail').map((c) => c.name).join(', ')}` });

  await announceSetupPage();
  const setupUrl = setupPageUrl();
  const result = {
    workspace: state.ctx?.projectId ?? null,
    repo: state.repo,
    phases,
    user_actions: state.actions,
    setup_url: setupUrl,
    doctor: { ready, checks },
    next: nextStep(phases, state.actions, ready, state, setupUrl),
  };
  const code = phases.some((p) => p.status === 'failed') ? 1 : state.actions.length > 0 || !ready ? 4 : 0;
  if (setupUrl && flags.wait && code === 4) {
    const waitStarted = Date.now();
    const left = await waitForSetup(state, flags.waitTimeout);
    waitedS += Math.round((Date.now() - waitStarted) / 1000);
    // Done on the page: one more pass finishes the phases that waited and prints the result.
    if (left.length === 0) {
      const again = original.filter((arg) => arg !== '--wait');
      carriedWaitS = waitedS;
      return runOnboard(again.includes('--no-open') ? again : [...again, '--no-open']);
    }
    result.next = `The setup page still lists ${left.map((item) => item.name).join(', ')} after ${flags.waitTimeout}s. Run kortix onboard --yes --json --wait again when the person is back.`;
  }
  const credential = currentCredential();
  await reportOnboardRun(credential, {
    project_id: state.ctx?.projectId ?? null,
    exit_code: code,
    wait: flags.wait,
    waited_s: waitedS,
    duration_s: Math.round((Date.now() - runStarted) / 1000),
    steps_left: state.actions.length,
    connectors: state.needs.connectors.length,
    secrets: state.needs.secrets.length,
    sandbox_templates: state.needs.sandbox_templates.length,
    slack: state.needs.uses_slack || state.opts.channels.length > 0,
    phases: Object.fromEntries(phases.map((phase) => [phase.name, phase.status])),
  });
  if (code === 0) await reportSetupReady(credential, { project_id: state.ctx?.projectId ?? null, via: 'onboard' });
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`\n  ${result.next}\n\n`);
  return code;
}
