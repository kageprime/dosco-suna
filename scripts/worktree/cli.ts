#!/usr/bin/env bun
/**
 * pnpm worktree — isolated multi-instance dev worktrees.
 *
 * Interactive: run `pnpm worktree` for a menu, or `pnpm worktree create` for a
 * guided wizard. Non-interactive (CI/scripts):
 *
 *   pnpm worktree create --name <feat> [--branch b] [--from dev] [--db] [--no-start] [--yes]
 *   pnpm worktree start <feat> [--billing] [--stripe] [--no-web]
 *   pnpm worktree web <feat> [--billing]   (only `next dev`, for a stack started with --no-web)
 *   pnpm worktree stop|status <feat>
 *   pnpm worktree nuke <feat> [feat2 …] [--force] [--yes]   (confirms each unless --yes)
 *   pnpm worktree nuke            (TTY: pick from a list, then confirm each)
 *   pnpm worktree list · doctor
 *   pnpm worktree sweep [--idle 60m] [--yes]   (delete build output in idle checkouts)
 *   pnpm worktree autoclean [--dry-run] [--yes] [--install-cron | --uninstall-cron]
 *     (sweep build output idle ≥24h, cap build output at 3 GB in stopped
 *      checkouts, remove clean pushed worktrees idle ≥48h (merged ≥24h) and
 *      Claude isolation worktrees, delete leftover worktree-agent-* branches,
 *      pressure mode below 15 GB free; runs at the start of `create` and
 *      `start` and every 15 min from $KORTIX_HOME/bin/worktree-autoclean.js)
 *
 * One command from a fresh clone sets up EVERYTHING (deps, git worktree, unique
 * ports, install, optional isolated Supabase, prereqs + node-pg-migrate) and boots the stack. Many
 * worktrees run at once with zero collisions; the primary `pnpm dev` is untouched except
 * when the default shared-DB mode deliberately uses its standard local Supabase.
 */
import {
  STRIDE, BASE, computePorts, loadRegistry, saveRegistry, withLock, sanitizeName,
  pickSlot, sh, run, which, portInUse, repoRoot, defaultWorktreePath, branchExists, freshBase, worktreeAddArgs, removeWorktree,
  renderSupabaseProject, runMigrate, supa, supaStatusEnv, slotCredsFromStatus, apiLaunchEnv, webLaunchEnv, gatewayLaunchEnv,
  writeMarker, ensureDeps, checkDeps, supaWorkdir, slotDir, startTunnel, tunnelAnswers, startStripeListen, WT_HOME, REGISTRY_PATH,
  startSupabaseDb, startSupabaseFullStack, hasKortixSchema, ensureRuntimeArtifacts, dbModeOf,
  ensurePrimarySupabase, primaryCredsFromStatus, primarySupabaseStatusEnv, SHARED_SUPABASE_PORTS, supabaseBin,
  branchDbName, primaryDb, branchDbExists, createBranchDb, syncBranchUsers, dropBranchDb, withDatabase,
  killTree, stackRoots, stackPids, listenersOn, psTable, cwdTable,
  listenPorts, buildRows, sortRows, filterRows, renderRail, renderDetail, toJsonRows,
  parseDuration, selectForPrune, type PruneCandidate, ARTIFACT_DIRS, sweepBusy,
  autocleanConfig, parsePorcelain, meaningfulChanges, isNoise, lastActivity, decideAutoclean,
  diskLevel, diskThresholds, parseDfFreeBytes, cronLine, hasCronLine, withCronLine, withoutCronLine,
  autocleanPass, decideCap, capOwnerDir, fmtKb, cacheTrims, installRunning, RECENT_WRITE_MIN,
  parseWorktreePorcelain, isClaudeWorktree, lockState, procStatStart, mergedPrIndex, prCovering, decideBranch,
  BUNDLE_NAME, scheduledCommand, currentCronLine, generationOf, loopScript, isLoopFor, pickScheduler,
  bundleRebuildReason, parseStamp,
  type AutocleanCandidate, type AutocleanVerdict, type AutocleanConfig, type AutocleanPass, type CapDir, type CapVerdict,
  type CacheTrim, type LockState, type MergedPr, type ScheduleTarget, type Scheduler, type BundleStamp, type RunningCode,
  type Registry, type SlotEntry, type Ports, type Tunnel, type StripeListen,
  type DbMode, type KillResult, type PrimaryDb, type SlotCreds,
} from './lib';
import { existsSync, rmSync, statSync, fstatSync, linkSync, openSync, closeSync, writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join as joinPath } from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';

const API_FILTER = 'kortix-api';
const WEB_FILTER = 'Kortix-Computer-Frontend';
const GATEWAY_FILTER = '@kortix/llm-gateway-server';
// Per-port clash lines `create` prints before it summarises the rest.
const CLASH_LOG_LIMIT = 5;

const step = (s: string) => console.log(`\n${pc.cyan('▸')} ${pc.bold(s)}`);
const sub = (s: string) => console.log(`  ${pc.dim(s)}`);
const ok = (s: string) => console.log(`${pc.green('✓')} ${s}`);
const warn = (s: string) => console.log(`${pc.yellow('!')} ${s}`);
const die = (s: string): never => { console.error(`\n${pc.red('✗')} ${s}`); process.exit(1); };
const url = (u: string) => pc.cyan(pc.underline(u));

// Free any stale process still holding this slot's ports — a previous `up` that
// didn't shut down cleanly, or a gateway that crashed but left the port bound.
// Without this the fresh gateway hits EADDRINUSE on its slot port; and because
// `bun --hot` stays alive after a startup throw (it keeps the reload watcher
// running), it would never actually listen, yet `Promise.race([...exited])`
// can't see it — so the API would silently fall back to the single-model
// passthrough. We only ever touch this worktree's own slot ports.
async function freeSlotPorts(ports: Ports): Promise<void> {
  const roots: number[] = [];
  for (const [label, port] of [['web', ports.web], ['api', ports.api], ['gateway', ports.gateway]] as const) {
    const pids = listenersOn(port);
    if (pids.length) {
      sub(`freeing stale ${label} process on :${port} (pid ${pids.join(', ')})`);
      roots.push(...pids);
    }
  }
  if (!roots.length) return;
  const res = await killTree(roots);
  if (res.survived.length) warn(`could not free ${plural(res.survived.length, 'process', 'processes')} still holding this slot's ports (${res.survived.join(', ')})`);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Record the status. `used` also stamps lastUsedAt: pass it only from commands
 * a person runs on this one worktree (start, web, stop), never from bulk ones.
 */
async function setStatus(name: string, status: SlotEntry['status'], used = false): Promise<void> {
  await withLock(() => {
    const r = loadRegistry();
    if (r.slots[name]) {
      r.slots[name].status = status;
      if (used) r.slots[name].lastUsedAt = new Date().toISOString();
      saveRegistry(r);
    }
  });
}

async function markUsed(name: string): Promise<void> {
  await withLock(() => {
    const r = loadRegistry();
    if (r.slots[name]) { r.slots[name].lastUsedAt = new Date().toISOString(); saveRegistry(r); }
  });
}

/**
 * Tear down one worktree's whole stack and report what survived.
 *
 * Callers MUST gate the registry write on `survived` being empty. Recording
 * "stopped" for a kill that did not happen is precisely what made `list` report
 * stacks as stopped while 20 of their processes were still resident.
 */
/**
 * A stack costs ~19 processes, and Next dev under Turbopack climbs to 1–3 GB and
 * never gives it back, so a handful of forgotten stacks is enough to exhaust swap
 * on a developer laptop. Warn before adding to the pile rather than letting the
 * OOM killer deliver the news.
 */
const CROWDED_STACKS = 3;
function warnOnStackPressure(current: string, reg: Registry): void {
  const tables = { rows: psTable(), cwds: cwdTable() };
  const live = Object.entries(reg.slots)
    .filter(([n, e]) => n !== current && stackPids(e.path, e.ports.api, tables).length > 0)
    .map(([n]) => n);
  if (live.length < CROWDED_STACKS) return;
  warn(`${live.length} other worktree stacks are already running (${live.join(', ')})`);
  sub(`each holds ~19 processes and a few GB — free them with ${pc.cyan('pnpm worktree stop --all')}`);
}

/**
 * Two stacks on the SHARED primary Supabase share one work queue — prompt-inbox
 * delivery, session-lifecycle commands, sandbox env sync. Whichever API instance
 * grabs a job pushes ITS `KORTIX_URL`-derived gateway URL into the box. If that
 * other stack's tunnel has rotted (quick tunnels do, every few hours), the next
 * prompt it picks up dies inside the agent runtime with
 * `Cannot connect to API … <other-stack>.trycloudflare.com/v1/llm-gateway`, and
 * nothing in THIS stack's log explains it. 2026-08-22: `mw-perf`'s dead tunnel
 * was pushed into a `timeline-parity` box this way. Say it at start, where the
 * decision (one stack, or `--db`) is still cheap.
 */
const PRIMARY_API_PORT = 8008;
function warnOnSharedDbCrosstalk(current: string, reg: Registry): void {
  const me = reg.slots[current];
  if (!me || dbModeOf(me) !== 'shared') return;
  const others = Object.entries(reg.slots)
    .filter(([n, e]) => n !== current && dbModeOf(e) === 'shared' && portInUse(e.ports.api).inUse)
    .map(([n, e]) => `${n} (api :${e.ports.api})`);
  if (portInUse(PRIMARY_API_PORT).inUse) others.unshift(`primary pnpm dev (api :${PRIMARY_API_PORT})`);
  if (others.length === 0) return;
  warn(`${plural(others.length, 'other stack is', 'other stacks are')} live on the SAME shared DB: ${others.join(', ')}`);
  sub('they share one work queue (prompt delivery, session lifecycle, env sync) — whichever API grabs a job pushes ITS KORTIX_URL into the sandbox;');
  sub(`a rotted tunnel over there surfaces HERE as "Cannot connect to API …trycloudflare.com/v1/llm-gateway" on the first prompt.`);
  sub(`run one stack at a time (${pc.cyan('pnpm worktree stop <name>')}), or recreate this worktree with ${pc.cyan('--db')} for an isolated database.`);
}

/** The primary Supabase (started if down) that branch databases live in. */
async function primaryForBranch(): Promise<{ creds: SlotCreds; db: PrimaryDb }> {
  const creds = primaryCredsFromStatus(await ensurePrimarySupabase(repoRoot()));
  if (!creds.serviceRoleKey || !creds.anonKey) {
    die('primary Supabase credentials are unavailable. Start the primary local stack once with `pnpm dev`.');
  }
  const db = primaryDb(creds.dbUrl);
  if (!db) die(`no running supabase_db_* container publishes the primary database (${creds.dbUrl})`);
  return { creds, db: db! };
}

/** Copy (first time only), migrate to this branch, and sync auth.users. Returns the DB URL. */
async function ensureBranchDatabase(name: string, path: string, db: PrimaryDb): Promise<string> {
  const dbName = branchDbName(name);
  const url = withDatabase(db.url, dbName);
  if (!branchDbExists(db, name)) {
    step(`Copying the primary database into ${dbName}`);
    const t0 = performance.now();
    const err = createBranchDb(db, name);
    if (err) die(`${dbName}: ${err}`);
    sub(`copied in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  step(`Applying this branch's migrations to ${dbName}`);
  if (await runMigrate(path, url) !== 0) die(`migrate failed on ${dbName}`);
  if (!hasKortixSchema(url)) die(`${dbName} has no kortix schema after migrate`);
  step('Syncing auth.users from the primary');
  const err = syncBranchUsers(db, name);
  if (err) die(`${dbName}: ${err}`);
  return url;
}

async function removeIsolatedSupabase(name: string, pid: string): Promise<void> {
  await spin('Stopping Supabase containers', [supabaseBin(), '--workdir', supaWorkdir(name), 'stop', '--no-backup']);
  await spin('Removing Docker containers', ['bash', '-lc', `docker rm -f $(docker ps -aq --filter "name=_${pid}$") 2>/dev/null || true`]);
  await spin('Removing volumes & network', ['bash', '-lc', `docker volume rm $(docker volume ls -q --filter "name=_${pid}$") 2>/dev/null; docker network rm supabase_network_${pid} 2>/dev/null || true`]);
}

async function stopStack(e: SlotEntry, opts: { quiet?: boolean } = {}): Promise<KillResult> {
  const roots = stackRoots(e.path, e.ports);
  const res = await killTree(roots);
  if (!opts.quiet) {
    if (!res.targeted.length) sub('no stack processes running');
    else sub(`killed ${plural(res.targeted.length, 'process', 'processes')} ${pc.dim(`(${plural(roots.length, 'root', 'roots')} + descendants)`)}`);
  }
  return res;
}

// Gate on the gateway actually listening. The API proxies sandbox LLM traffic to
// it, so a dead gateway silently degrades sandboxes to the single-model
// passthrough (wrong catalog). `bun --hot` swallows a startup crash, so the
// exit-race never fires — poll the readiness endpoint and say so plainly.
async function waitForGateway(port: number, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      warn(`llm gateway exited (code ${proc.exitCode}) before it came up — the API will fall back to the single-model passthrough. See the gateway logs above.`);
      return;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) { ok(`llm gateway ready on :${port}`); return; }
    } catch {}
    await Bun.sleep(500);
  }
  warn(`llm gateway never became healthy on :${port} (30s) — the API will fall back to the single-model passthrough (wrong catalog). Is :${port} already in use? Check the gateway logs above.`);
}
const dot = (up: boolean) => (up ? pc.green('●') : pc.dim('○'));

async function spin(label: string, cmd: string[]): Promise<void> {
  const s = clack.spinner();
  s.start(label);
  try {
    await Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).exited;
    s.stop(`${label} ${pc.green('✓')}`);
  } catch {
    s.stop(`${label} ${pc.dim('(skipped)')}`);
  }
}

interface Args { cmd: string; name?: string; names: string[]; flags: Record<string, string | boolean>; }
function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'help';
  const flags: Record<string, string | boolean> = {};
  const names: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else names.push(a);
  }
  if (typeof flags.name === 'string') names.unshift(flags.name);
  return { cmd, name: names[0], names, flags };
}

function usage(): never {
  console.log(`
${pc.bgCyan(pc.black(' pnpm worktree '))}  ${pc.dim('isolated multi-instance dev worktrees')}

  ${pc.cyan('pnpm worktree')}                 ${pc.dim('interactive menu')}
  ${pc.cyan('pnpm worktree create')}          ${pc.dim('guided wizard (or --name <n> --from <branch> [--db] [--no-tunnel])')}
  ${pc.cyan('start')} ${pc.dim('<n> [--billing] [--stripe] [--no-tunnel] [--no-web]')}   ${pc.cyan('web')} ${pc.dim('<n> [--billing]')}   ${pc.cyan('stop')} ${pc.dim('<n> | --all')}   ${pc.cyan('nuke')} ${pc.dim('<n> [n…] [--force] [--yes]')}
  ${pc.cyan('nuke --all')} ${pc.dim('[--older-than 3d] [--idle 2d] [--include-dirty] [--dry-run] [--yes]')}   ${pc.dim('bulk: skips running stacks + dirty trees')}
  ${pc.cyan('pr')} ${pc.dim('<n> [--title … --base dev --draft --web]')}
  ${pc.cyan('list')} ${pc.dim('[name] [--json]')}   ${pc.cyan('status')} ${pc.dim('[n]')}   ${pc.cyan('doctor')} ${pc.dim('[--yes]')}
  ${pc.cyan('sweep')} ${pc.dim('[--idle 60m] [--yes]')}   ${pc.dim('delete .next/.turbo/dist/target/test output in idle checkouts; dry run without --yes')}
  ${pc.cyan('autoclean')} ${pc.dim('[--dry-run] [--yes] [--install-cron | --uninstall-cron]')}   ${pc.dim('sweep idle ≥24h, cap build output 3 GB, remove clean pushed/merged worktrees; runs on create/start + every 15 min')}

Each worktree gets a unique port block (base ${BASE.web}/${BASE.api}, +${STRIDE} per slot),
shares the primary Supabase DB by default, and gets its own node_modules. Pass ${pc.cyan('--db')}
for its own database inside the primary Supabase (a copy of the primary, migrated to the branch),
or ${pc.cyan('--full-supabase')} for a separate Supabase project. State in ${pc.dim(WT_HOME)}.
The primary ${pc.bold('pnpm dev')} (3000/8008) is never touched.`);
  process.exit(2);
}

function need(name: string | undefined): string {
  if (!name) die('a worktree <name> is required (or run `pnpm worktree` for the menu)');
  return sanitizeName(name!);
}

function portsLine(p: Ports): string {
  return `${pc.bold('web')} ${pc.green(String(p.web))} ${pc.dim('·')} ${pc.bold('api')} ${pc.green(String(p.api))} ` +
    `${pc.dim('·')} db ${pc.green(String(p.sbDb))} ${pc.dim('·')} studio ${pc.green(String(p.sbStudio))} ${pc.dim('·')} inbucket ${pc.green(String(p.sbInbucket))}`;
}
function dbModeFromFlags(flags: Record<string, string | boolean>): DbMode {
  if (flags['full-supabase']) return 'isolated';
  if (flags.db || flags['with-db'] || flags['isolated-db']) return 'branch';
  return 'shared';
}
const DB_MODE_FLAGS = ['db', 'with-db', 'isolated-db', 'full-supabase', 'no-db', 'shared-db'];
function dbLabel(mode: DbMode, name?: string): string {
  if (mode === 'isolated') return 'isolated Supabase';
  if (mode === 'branch') return `own database${name ? ' ' + branchDbName(name) : ''} in the shared primary Supabase`;
  return 'shared primary Supabase';
}

function currentBranch(): string { return sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'dev'; }
function recentBranches(limit = 12): string[] {
  return sh(['git', 'for-each-ref', `--count=${limit}`, '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
function branchConflict(root: string, branch: string): string | null {
  if (!sh(['git', '-C', root, 'check-ref-format', `refs/heads/${branch}`]).ok)
    return `"${branch}" is not a valid git branch name`;
  const kids = sh(['git', '-C', root, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}/`]).stdout.trim();
  if (kids) return `a branch namespace "${branch}/…" already exists (e.g. "${kids.split('\n')[0]}") — git can't also have a branch literally named "${branch}"`;
  const parts = branch.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (branchExists(root, parent)) return `branch "${parent}" already exists, so "${branch}" can't be created beneath it`;
  }
  return null;
}

function cancelled(v: unknown): boolean { if (clack.isCancel(v)) { clack.cancel('Cancelled.'); return true; } return false; }

async function confirmStripe(): Promise<boolean> {
  const v = await clack.confirm({ message: 'Enable Stripe? (billing on + webhook forwarding to this worktree)', initialValue: false });
  return clack.isCancel(v) ? false : v;
}

async function promptCreate(): Promise<Args | null> {
  const name = await clack.text({
    message: 'Name for the worktree',
    placeholder: 'sandbox-core',
    validate: (v) => { const t = (v ?? '').trim(); if (!t) return 'Required'; if (!/^[a-zA-Z0-9-]+$/.test(t)) return 'letters, numbers and dashes only'; },
  });
  if (cancelled(name)) return null;
  const cur = currentBranch();
  const seen = new Set<string>();
  const ordered = ['dev', cur, ...recentBranches(12)].filter((b) => b && !seen.has(b) && (seen.add(b), true));
  const OTHER = ' other';
  const sel = await clack.select({
    message: 'Base branch to fork from',
    initialValue: 'dev',
    maxItems: 8,
    options: [
      ...ordered.map((b) => ({ value: b, label: b === 'dev' ? `${b} ${pc.dim('(default)')}` : b === cur ? `${b} ${pc.dim('(current)')}` : b })),
      { value: OTHER, label: pc.dim('✎ type a branch name…') },
    ],
  });
  if (cancelled(sel)) return null;
  let from = String(sel);
  if (from === OTHER) {
    const typed = await clack.text({
      message: 'Branch name',
      placeholder: cur,
      validate: (v) => { const t = (v ?? '').trim(); if (!t) return 'Required'; if (!branchExists(repoRoot(), t)) return `branch "${t}" not found`; },
    });
    if (cancelled(typed)) return null;
    from = String(typed);
  }
  const start = await clack.confirm({ message: 'Boot the dev servers when it’s ready?', initialValue: true });
  if (cancelled(start)) return null;
  const isolatedDb = await clack.confirm({ message: 'Give this worktree its own database (a copy of the primary)?', initialValue: false });
  if (cancelled(isolatedDb)) return null;
  const stripe = start ? await confirmStripe() : false;
  const n = String(name);
  return { cmd: 'create', name: n, names: [n], flags: { from: String(from), yes: true, ...(isolatedDb ? { db: true } : {}), ...(start ? {} : { 'no-start': true }), ...(stripe ? { stripe: true } : {}) } };
}

async function pickWorktree(action: string): Promise<string | null> {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { clack.cancel('No worktrees yet — create one first.'); return null; }
  const sel = await clack.select({
    message: `Which worktree to ${pc.bold(action)}?`,
    options: names.sort((x, y) => reg.slots[x].slot - reg.slots[y].slot).map((n) => {
      const e = reg.slots[n];
      return { value: n, label: `${dot(e.status === 'running')} ${n}`, hint: `slot ${e.slot} · ${e.status} · web ${e.ports.web}` };
    }),
  });
  if (cancelled(sel)) return null;
  return String(sel);
}

async function pickWorktrees(action: string): Promise<string[] | null> {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { clack.cancel('No worktrees yet — create one first.'); return null; }
  const sel = await clack.multiselect({
    message: `Which worktrees to ${pc.bold(action)}? ${pc.dim('(space to select, enter to confirm)')}`,
    options: names.sort((x, y) => reg.slots[x].slot - reg.slots[y].slot).map((n) => {
      const e = reg.slots[n];
      return { value: n, label: `${dot(e.status === 'running')} ${n}`, hint: `slot ${e.slot} · ${e.status} · web ${e.ports.web}` };
    }),
    required: true,
  });
  if (cancelled(sel)) return null;
  return (sel as string[]).map(String);
}

async function menu(): Promise<Args | null> {
  const action = await clack.select({
    message: 'What would you like to do?',
    options: [
      { value: 'create', label: `${pc.green('✦')} create`, hint: 'set up a new isolated worktree' },
      { value: 'start', label: `${pc.cyan('▶')} start`, hint: 'boot an existing worktree' },
      { value: 'stop', label: `${pc.yellow('■')} stop`, hint: 'stop a worktree (keeps data)' },
      { value: 'list', label: `${pc.blue('≡')} list`, hint: 'all worktrees + ports' },
      { value: 'status', label: `${pc.magenta('◇')} status`, hint: 'live health' },
      { value: 'pr', label: `${pc.green('⇡')} pr`, hint: 'push the branch + open a PR' },
      { value: 'nuke', label: `${pc.red('✗')} nuke`, hint: 'tear down + free the slot' },
      { value: 'doctor', label: `${pc.dim('✚')} doctor`, hint: 'check the toolchain' },
    ],
  });
  if (cancelled(action)) return null;
  const cmd = String(action);
  if (cmd === 'create') return promptCreate();
  if (cmd === 'nuke') {
    const names = await pickWorktrees(cmd);
    if (!names || !names.length) return null;
    return { cmd, name: names[0], names, flags: { force: true } };
  }
  if (['start', 'stop', 'status', 'pr'].includes(cmd)) {
    const name = await pickWorktree(cmd);
    if (!name) return null;
    const flags: Record<string, string | boolean> = {};
    if (cmd === 'start' && await confirmStripe()) flags.stripe = true;
    return { cmd, name, names: [name], flags };
  }
  return { cmd, name: undefined, names: [], flags: {} };
}

async function cmdCreate(a: Args) {
  const name = need(a.name);
  await runAutoclean({ mode: 'auto', dryRun: false, current: name });
  diskGuard('create');
  ensureScheduleQuietly();
  const tunnel = !a.flags['no-tunnel'];
  const install = !!a.flags.yes;
  const requestedDbMode = dbModeFromFlags(a.flags);
  const startsNow = !a.flags['no-start'];
  const needsDatabaseTooling = requestedDbMode === 'isolated' || startsNow;
  const needsIsolatedDatabaseTooling = requestedDbMode !== 'shared';

  step('Preflight: toolchain');
  if (!(await ensureDeps({ database: needsDatabaseTooling, isolatedDatabase: needsIsolatedDatabaseTooling, tunnel, install }))) {
    die('Missing dependencies above. Re-run with --yes to auto-install, or install them and retry.');
  }

  const root = repoRoot();
  // An absolute core.hooksPath makes every worktree run the primary
  // checkout's hooks, from whatever branch the primary has checked out.
  // 2026-11-08: the primary's stale pre-commit ran `dotenvx protect` from a
  // worktree and pointed the global git filter at that worktree. `.githooks`
  // is what `pnpm install` sets (package.json `prepare`).
  const hooksPath = sh(['git', '-C', root, 'config', '--get', 'core.hooksPath']).stdout.trim();
  if (hooksPath && isAbsolute(hooksPath)) {
    sh(['git', '-C', root, 'config', 'core.hooksPath', '.githooks']);
    sub(`core.hooksPath was ${hooksPath}; set it to .githooks so each worktree runs its own hooks`);
  }
  const wtPath = defaultWorktreePath(root, name);
  const branch = (typeof a.flags.branch === 'string' && a.flags.branch) || name;
  // `dev` (the default) resolves to a freshly fetched origin/dev, never the
  // primary checkout's possibly stale local main.
  const from = freshBase(root, (typeof a.flags.from === 'string' && a.flags.from) || 'dev');

  if (!branchExists(root, branch)) {
    const conflict = branchConflict(root, branch);
    if (conflict) die(`can't create branch "${branch}": ${conflict}.\n  Pick another name: pnpm worktree create --name ${name} --branch <branch>`);
  }

  let isNew = false;
  // `--db` on an old full-stack worktree moves it onto a branch database and
  // deletes its Supabase containers. Every other mode switch needs a recreate.
  let converting = false;
  const entry = await withLock<SlotEntry>(() => {
    const reg = loadRegistry();
    if (reg.slots[name]) {
      const existing = reg.slots[name];
      const existingMode = dbModeOf(existing);
      const explicit = DB_MODE_FLAGS.some((f) => a.flags[f]);
      converting = explicit && existingMode === 'isolated' && requestedDbMode === 'branch';
      if (explicit && !converting && existingMode !== requestedDbMode) {
        throw new Error(`worktree "${name}" already uses ${dbLabel(existingMode)}; nuke/recreate it to switch database modes`);
      }
      sub(`resuming existing worktree "${name}" (slot ${existing.slot}, ${dbLabel(existingMode, name)})`);
      existing.lastUsedAt = new Date().toISOString(); saveRegistry(reg);
      return existing;
    }
    isNew = true;
    // One lsof scan for the whole box; a missing lsof probes as "all free", as
    // the old per-port probe did.
    const live = listenPorts() ?? new Set<number>();
    const { slot, clashes } = pickSlot(reg, (p) => live.has(p));
    for (const c of clashes.slice(0, CLASH_LOG_LIMIT)) {
      const who = portInUse(c.port);
      sub(`port ${c.port} (${c.service}) in use by ${who.cmd ?? '?'} (pid ${who.pid ?? '?'}) — trying next slot`);
    }
    if (clashes.length > CLASH_LOG_LIMIT) sub(`… and ${clashes.length - CLASH_LOG_LIMIT} more slots with a port in use`);
    // Throw, not die(): process.exit would skip withLock's unlock.
    if (slot === null) {
      throw new Error(`could not find a free port block: slots ${clashes[0].slot}–${clashes.at(-1)!.slot} (${clashes.length} unregistered) each have a port in use`);
    }
    const ports = computePorts(slot);
    const e: SlotEntry = { slot, projectId: `kortix-wt-${name}`, path: wtPath, branch, ports, dbMode: requestedDbMode, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: 'created' };
    reg.slots[name] = e; saveRegistry(reg);
    return e;
  });

  const dbMode: DbMode = converting ? 'branch' : dbModeOf(entry);
  if (converting && process.stdin.isTTY && process.stdout.isTTY && !a.flags.yes) {
    const v = await clack.confirm({
      message: `Move ${pc.bold(name)} to its own database in the primary Supabase? This deletes its Supabase containers and volumes (${entry.projectId}).`,
      initialValue: false,
    });
    if (clack.isCancel(v) || !v) die('cancelled');
  }
  if (dbMode !== 'shared' && !needsDatabaseTooling) {
    step('Preflight: database tooling');
    if (!(await ensureDeps({ database: true, isolatedDatabase: true, install }))) {
      die('Missing database dependencies above. Re-run with --yes to auto-install, or install them and retry.');
    }
  }
  step(`Slot ${entry.slot} — ${portsLine(entry.ports)} — ${dbLabel(dbMode, name)}`);

  const failCreate = async (msg: string): Promise<never> => {
    if (isNew) await withLock(() => { const r = loadRegistry(); delete r.slots[name]; saveRegistry(r); });
    return die(msg);
  };

  step(`Git worktree ${pc.dim('→')} ${wtPath}`);
  const existing = sh(['git', '-C', root, 'worktree', 'list', '--porcelain']).stdout;
  if (existing.includes(`worktree ${wtPath}`)) {
    sub('already exists — reusing');
  } else {
    const { args, mode } = worktreeAddArgs(root, wtPath, branch, from);
    const r = sh(args);
    if (!r.ok) await failCreate(`${args.slice(0, 5).join(' ')} failed: ${r.stderr}`);
    if (mode === 'local') sub(`checked out existing branch "${branch}"`);
    else if (mode === 'remote') sub(`checked out "${branch}" tracking origin/${branch}`);
    else sub(`created branch "${branch}" from ${from}`);
  }

  // Use the shared global pnpm store (default). Each worktree still has its own
  // isolated node_modules/.pnpm virtual layer (separate working tree), so a
  // sibling install can't touch it; the content store is concurrency-safe by
  // design. A per-worktree --store-dir defeats hardlink dedup and materialised
  // a full ~2.8GB copy per worktree (91 of them once leaked 244GB into ~/.kortix).
  step('Installing dependencies (shared pnpm store)');
  if (await run(['pnpm', 'install'], { cwd: wtPath }) !== 0) die(`pnpm install failed — fix and re-run \`pnpm worktree create --name ${name}\``);

  if (dbMode === 'isolated') {
    step(`Rendering isolated Supabase project ${pc.dim('('+entry.projectId+')')}`);
    renderSupabaseProject(name, wtPath, entry.projectId, entry.ports);

    step(`Starting isolated Postgres on db ${entry.ports.sbDb}`);
    if (await startSupabaseDb(name) !== 0) die('supabase db start failed');

    step('Building schema (prereqs + pnpm migrate)');
    if (await runMigrate(wtPath, entry.ports) !== 0) die(`migrate failed — fix and re-run \`pnpm worktree create --name ${name}\``);
    if (!hasKortixSchema(entry.ports)) die(`schema not built — \`pnpm migrate\` produced no kortix schema on branch "${branch}".\n  Check packages/db/migrations/*.sql exist on this branch and the Supabase prereqs applied (psql + Basejump).`);

    step(`Starting isolated Supabase on api ${entry.ports.sbApi}`);
    if (await startSupabaseFullStack(name, entry.ports) !== 0) die('supabase start failed');
  } else if (dbMode === 'branch') {
    const { db } = await primaryForBranch();
    await ensureBranchDatabase(name, wtPath, db);
    if (converting) {
      await removeIsolatedSupabase(name, entry.projectId);
      await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].dbMode = 'branch'; saveRegistry(r); } });
      entry.dbMode = 'branch';
    }
  } else {
    sub(`database mode: shared — skips Supabase project creation; start uses the primary checkout's standard local Supabase`);
  }

  step('Building runtime artifacts');
  if (await ensureRuntimeArtifacts(wtPath) !== 0) die('runtime artifact build failed');

  writeMarker(wtPath, entry);
  await withLock(() => { const reg = loadRegistry(); if (reg.slots[name]) { reg.slots[name].status = 'created'; reg.slots[name].lastUsedAt = new Date().toISOString(); saveRegistry(reg); } });

  clack.note(
    `${pc.dim('path')}    ${wtPath}\n` +
    `${pc.dim('web')}     ${url('http://localhost:' + entry.ports.web)}\n` +
    `${pc.dim('api')}     http://localhost:${entry.ports.api}\n` +
    (dbMode === 'isolated'
      ? `${pc.dim('studio')}  http://localhost:${entry.ports.sbStudio}`
      : `${pc.dim('db')}      ${dbMode === 'branch' ? branchDbName(name) + ' in ' : ''}shared primary Supabase (${SHARED_SUPABASE_PORTS.sbApi}/${SHARED_SUPABASE_PORTS.sbDb})`),
    pc.green(`✓ worktree "${name}" ready`),
  );
  if (a.flags['no-start']) { ok(`start it:  ${pc.cyan('pnpm worktree start ' + name)}`); }
  else { await cmdStart({ cmd: 'start', name, names: [name], flags: { 'skip-autoclean': true, ...(a.flags['no-tunnel'] ? { 'no-tunnel': true } : {}), ...(a.flags.stripe ? { stripe: true } : {}), ...(a.flags['no-web'] ? { 'no-web': true } : {}) } }); }
}

async function cmdStart(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const entry = reg.slots[name];
  if (!entry) die(`unknown worktree "${name}" — create it first`);
  if (!existsSync(entry!.path)) die(`worktree dir missing (${entry!.path}); run \`pnpm worktree nuke ${name}\` then recreate`);
  if (!a.flags['skip-autoclean']) {
    await runAutoclean({ mode: 'auto', dryRun: false, current: name });
    diskGuard('start');
    ensureScheduleQuietly();
  }
  capNextBeforeStart(entry!);
  if (!(await ensureDeps({ database: true, isolatedDatabase: dbModeOf(entry) !== 'shared', tunnel: !a.flags['no-tunnel'], install: false }))) {
    die('Missing dependencies above. Install them and retry.');
  }
  if (!sh(['docker', 'info']).ok) die('Docker daemon not running — start Docker and retry');
  const e = entry!;
  const dbMode = dbModeOf(e);
  warnOnStackPressure(name, reg);

  // Heal a stale ports cache. The registry stores a denormalized copy of
  // computePorts(slot), so a worktree created before a port was added to BASE
  // (e.g. the standalone gateway) has that field missing — String(undefined)
  // then makes the gateway fall back to its default 8090 and the API lose its
  // proxy (LLM_GATEWAY_PROXY_PORT="undefined"). The slot is the source of truth:
  // recompute every port from it, and persist so the entry is fixed for good.
  const freshPorts = computePorts(e.slot);
  if (JSON.stringify(freshPorts) !== JSON.stringify(e.ports)) {
    const added = (Object.keys(freshPorts) as (keyof typeof freshPorts)[]).filter((k) => e.ports[k] !== freshPorts[k]);
    e.ports = freshPorts;
    await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].ports = freshPorts; saveRegistry(r); } });
    sub(`refreshed slot ${e.slot} ports from BASE (${added.join(', ')}) → gateway :${freshPorts.gateway}`);
  }

  let creds;
  if (dbMode === 'isolated') {
    renderSupabaseProject(name, e.path, e.projectId, e.ports);
    step(`Starting Postgres for "${name}"`);
    if (await startSupabaseDb(name) !== 0) die('supabase db start failed');
    step('Applying pending migrations (pnpm migrate)');
    if (await runMigrate(e.path, e.ports) !== 0) die('migrate failed');
    if (!hasKortixSchema(e.ports)) die(`schema not built for "${name}"`);
    if (!sh([supabaseBin(), '--workdir', supaWorkdir(name), 'status']).ok) {
      step(`Starting Supabase for "${name}"`);
      if (await startSupabaseFullStack(name, e.ports) !== 0) die('supabase start failed');
    } else if (!portInUse(e.ports.sbApi).inUse) {
      step(`Starting Supabase services for "${name}"`);
      if (await startSupabaseFullStack(name, e.ports) !== 0) die('supabase start failed');
    }
    creds = slotCredsFromStatus(e.ports, supaStatusEnv(name));
  } else if (dbMode === 'branch') {
    const primary = await primaryForBranch();
    creds = { ...primary.creds, dbUrl: await ensureBranchDatabase(name, e.path, primary.db) };
    sub(`${creds.supabaseUrl} · ${creds.dbUrl}`);
  } else {
    step('Using shared primary Supabase');
    const env = await ensurePrimarySupabase(repoRoot());
    creds = primaryCredsFromStatus(env);
    if (!creds.supabaseUrl || !creds.dbUrl || !creds.serviceRoleKey || !creds.anonKey) {
      die('primary Supabase credentials are unavailable. Start the primary local stack once with `pnpm dev`, or recreate this worktree with `--db` for an isolated database.');
    }
    if (!hasKortixSchema(creds.dbUrl)) {
      die('the shared primary Supabase DB does not have the kortix schema. Run the primary stack once to initialize it, or recreate this worktree with `--db` for an isolated database.');
    }
    sub(`${creds.supabaseUrl} · ${creds.dbUrl}`);
    warnOnSharedDbCrosstalk(name, reg);
  }
  step('Building runtime artifacts');
  if (await ensureRuntimeArtifacts(e.path) !== 0) die('runtime artifact build failed');

  for (const port of [e.ports.web, e.ports.api]) { const u = portInUse(port); if (u.inUse && u.pid) sh(['bash', '-lc', `kill ${u.pid} 2>/dev/null || true`]); }
  await withLock(() => { const r = loadRegistry(); if (r.slots[name]) { r.slots[name].status = 'running'; r.slots[name].lastUsedAt = new Date().toISOString(); saveRegistry(r); } });

  let tunnel: Tunnel | null = null;
  if (!a.flags['no-tunnel']) {
    step('Cloudflare tunnel (cloud sandbox callback)');
    tunnel = await startTunnel(e.ports.api);
    if (tunnel) sub(`KORTIX_URL → ${tunnel.url}`);
    else warn('no tunnel (cloudflared missing or timed out) — cloud sandboxes won’t be reachable; `brew install cloudflared` and restart, or pass --no-tunnel to silence');
  }

  let stripe: StripeListen | null = null;
  if (a.flags.stripe) {
    step('Stripe webhook forwarding (billing on)');
    stripe = await startStripeListen(e.ports.api);
    if (stripe) sub(`stripe listen → http://localhost:${e.ports.api}/v1/billing/webhooks/stripe  ${pc.dim('(whsec injected)')}`);
    else warn('stripe CLI missing or not logged in — billing NOT enabled. Install it and run `stripe login`, then restart with --stripe.');
  }
  const billing = !!a.flags.billing || !!stripe;
  // An API-only change needs no web server; each `next dev` holds GBs of RAM.
  const noWeb = !!a.flags['no-web'];

  await freeSlotPorts(e.ports);

  console.log(`\n${pc.green('🚀')} ${pc.bold(name)}   web ${noWeb ? pc.dim('off (--no-web)') : url('http://localhost:' + e.ports.web)}  ${pc.dim('·')}  api http://localhost:${e.ports.api}  ${pc.dim('·')}  ${dbMode === 'isolated' ? `studio http://localhost:${e.ports.sbStudio}` : `db ${pc.dim(dbLabel(dbMode, name))}`}`);
  console.log(`${pc.dim('   llm gateway')} http://localhost:${e.ports.gateway} ${pc.dim('(standalone · slot port · API proxies /v1/llm-gateway/*)')}`);
  if (tunnel) console.log(`${pc.dim('   sandbox callback')} ${url(tunnel.url)}`);
  if (billing) {
    console.log(
      `${pc.dim('   billing')} ${pc.green('on')} ${stripe ? pc.dim('· stripe webhooks → :' + e.ports.api) : pc.dim('· local routes only')}`,
    );
  }
  if (noWeb) sub(`open the UI on demand: pnpm worktree web ${name}`);
  console.log(pc.dim('   (Ctrl+C stops the dev servers cleanly)\n'));

  // The API's KORTIX_URL is baked at spawn, so a tunnel rotation has to
  // respawn it — keep the spawn in a function and the handle mutable.
  const spawnApi = (kortixUrl: string | undefined) =>
    Bun.spawn(['pnpm', '--filter', API_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...apiLaunchEnv(e.ports, creds, { kortixUrl, stripeWebhookSecret: stripe?.secret, billing, instanceId: name, dbMode }) }, stdout: 'inherit', stderr: 'inherit' });
  let api = spawnApi(tunnel?.url);
  let apiRestarting = false;
  const gateway = Bun.spawn(['pnpm', '--filter', GATEWAY_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...gatewayLaunchEnv(e.ports) }, stdout: 'inherit', stderr: 'inherit' });
  const web = noWeb ? null : Bun.spawn(['pnpm', '--filter', WEB_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...webLaunchEnv(e.ports, creds, { billing }) }, stdout: 'inherit', stderr: 'inherit' });
  void waitForGateway(e.ports.gateway, gateway);
  let stopping = false;
  // Quick tunnels die silently — cloudflared exits, or the URL starts answering
  // 530 while the process lives. 2026-08-22: three deaths in one evening; each
  // one surfaced as OpenCode "Retrying in 81s · <none>" (Cloudflare's HTML 530
  // has no message) or "Cannot connect to API …trycloudflare.com" on the first
  // prompt, and nothing local said why. Mirror scripts/dev-local.sh's watchdog:
  // every 60s, if the LOCAL API is healthy but the tunnel is dead (process gone,
  // or two consecutive probe failures), mint a new quick tunnel and respawn the
  // API with the new KORTIX_URL. Existing boxes pick the new gateway URL up on
  // their next prompt (env sync); their daemon callbacks stay on the old host.
  const startTunnelWatchdog = () => {
    if (!tunnel) return;
    const localHealthy = () => tunnelAnswers(`http://localhost:${e.ports.api}`, '/v1/health', 2000);
    void (async () => {
      while (!stopping) {
        await Bun.sleep(60_000);
        if (stopping || !tunnel) return;
        if (!(await localHealthy())) continue; // not the tunnel's fault
        const procDead = tunnel.proc.exitCode !== null;
        let dead = procDead || !(await tunnelAnswers(tunnel.url));
        if (dead && !procDead) { await Bun.sleep(5000); dead = !(await tunnelAnswers(tunnel.url)); } // confirm, avoid a blip
        if (!dead) continue;
        warn(`tunnel ${tunnel.url} is DEAD (${procDead ? 'cloudflared exited' : 'URL answers no health'}) — rotating + restarting the API…`);
        try { tunnel.proc.kill(); } catch {}
        const next = await startTunnel(e.ports.api);
        if (!next) { warn('tunnel rotation FAILED (cloudflared gave no URL) — will retry next minute'); continue; }
        tunnel = next;
        apiRestarting = true;
        try { api.kill(); } catch {}
        await Promise.race([api.exited, Bun.sleep(4000)]);
        api = spawnApi(tunnel.url);
        void watchApi();
        apiRestarting = false;
        ok(`tunnel rotated: KORTIX_URL → ${tunnel.url} (API restarted)`);
      }
    })();
  };
  // An API exit that WE did not cause (rotation) still tears the stack down.
  const watchApi = async () => {
    const mine = api;
    await mine.exited;
    if (!stopping && !apiRestarting && api === mine) await shutdown();
  };
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    console.log(`\n${pc.yellow('▸')} stopping…`);
    // Snapshot the process table BEFORE signalling anything: the moment a parent
    // dies its children reparent to launchd and the tree can no longer be
    // reconstructed from ppid. Killing the port holder alone is what used to leak
    // the ~15 Next workers behind it.
    const rows = psTable();
    const spawned = [api.pid, gateway.pid, web?.pid, tunnel?.proc.pid, stripe?.proc.pid]
      .filter((p): p is number => typeof p === 'number');
    const roots = [...new Set([...spawned, ...stackRoots(e.path, e.ports, { rows })])];
    try { api.kill(); } catch {} try { gateway.kill(); } catch {} try { web?.kill(); } catch {} try { tunnel?.proc.kill(); } catch {} try { stripe?.proc.kill(); } catch {}
    await Promise.race([Promise.all([api.exited, gateway.exited, web?.exited]), Bun.sleep(4000)]);
    const res = await killTree(roots, { rows });
    if (res.survived.length) {
      await setStatus(name, 'running', true);
      warn(`${plural(res.survived.length, 'process', 'processes')} survived SIGKILL (${res.survived.join(', ')}) — "${name}" left marked running`);
    } else {
      await setStatus(name, 'stopped', true);
      ok(`stopped — ${plural(res.targeted.length, 'process', 'processes')} reaped.`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  startTunnelWatchdog();
  void watchApi();
  await Promise.race(web ? [gateway.exited, web.exited] : [gateway.exited]);
  await shutdown();
}

/** `next dev` alone, for a stack already running with --no-web. Reads creds; never starts or migrates a database. */
async function cmdWeb(a: Args) {
  const name = need(a.name);
  const e = loadRegistry().slots[name] ?? die(`unknown worktree "${name}" — create it first`);
  if (!portInUse(e.ports.api).inUse) die(`no API listens on :${e.ports.api} for "${name}" — start the stack first: pnpm worktree start ${name} --no-web`);
  if (portInUse(e.ports.web).inUse) die(`web port ${e.ports.web} is already in use — stop that process first`);
  await markUsed(name);
  const mode = dbModeOf(e);
  const creds = mode === 'isolated' ? slotCredsFromStatus(e.ports, supaStatusEnv(name))
    : mode === 'branch' ? (await primaryForBranch()).creds
    : primaryCredsFromStatus(await ensurePrimarySupabase(repoRoot()));
  console.log(`\n${pc.green('🚀')} ${pc.bold(name)}   web ${url('http://localhost:' + e.ports.web)}  ${pc.dim('(Ctrl+C stops the web server only)')}\n`);
  const web = Bun.spawn(['pnpm', '--filter', WEB_FILTER, 'dev'], { cwd: e.path, env: { ...process.env, ...webLaunchEnv(e.ports, creds, { billing: !!a.flags.billing }) }, stdout: 'inherit', stderr: 'inherit' });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    // Snapshot before signalling: once `next dev` dies its workers reparent and the tree is lost.
    const rows = psTable();
    const roots = [...new Set([web.pid, ...listenersOn(e.ports.web)])];
    try { web.kill(); } catch {}
    await Promise.race([web.exited, Bun.sleep(4000)]);
    const res = await killTree(roots, { rows });
    if (res.survived.length) warn(`${plural(res.survived.length, 'process', 'processes')} survived SIGKILL (${res.survived.join(', ')})`);
    else ok(`web stopped — ${plural(res.targeted.length, 'process', 'processes')} reaped; api left running.`);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  await web.exited;
  await shutdown();
}

async function cmdStop(a: Args) {
  if (a.flags.all) return cmdStopAll();
  const name = need(a.name);
  const reg = loadRegistry();
  const e = reg.slots[name];
  if (!e) die(`unknown worktree "${name}"`);
  step(`Stopping "${name}"`);
  const res = await stopStack(e!);
  if (dbModeOf(e!) === 'isolated') sh([supabaseBin(), '--workdir', supaWorkdir(name), 'stop']);
  else sub('shared primary Supabase left running');
  if (res.survived.length) {
    await setStatus(name, 'running', true);
    warn(`${plural(res.survived.length, 'process', 'processes')} survived SIGKILL (${res.survived.join(', ')}) — "${name}" left marked running.`);
    sub(`inspect with ${pc.cyan(`ps -p ${res.survived.join(',')}`)}`);
    return;
  }
  await setStatus(name, 'stopped', true);
  ok(`stopped (data preserved). Restart with ${pc.cyan('pnpm worktree start ' + name)}.`);
}

/**
 * Stop every worktree in one pass — the end-of-day sweep, and the recovery path
 * when stacks have been orphaned by an OOM kill (their supervisor is gone, so
 * there is no Ctrl+C left to press and nothing else will ever reclaim them).
 */
async function cmdStopAll() {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { console.log(`\n  ${pc.dim('No worktrees.')}`); return; }
  step(`Stopping ${plural(names.length, 'worktree', 'worktrees')}`);
  let reaped = 0;
  const stubborn: string[] = [];
  for (const n of names) {
    const e = reg.slots[n];
    const res = await stopStack(e, { quiet: true });
    if (res.targeted.length) console.log(`  ${res.survived.length ? pc.red('✗') : pc.green('✓')} ${n} ${pc.dim(`${plural(res.targeted.length, 'process', 'processes')}`)}`);
    reaped += res.targeted.length - res.survived.length;
    if (res.survived.length) stubborn.push(n);
    else if (res.targeted.length) await setStatus(n, 'stopped');
  }
  if (stubborn.length) warn(`could not fully stop: ${stubborn.join(', ')}`);
  ok(`reaped ${plural(reaped, 'process', 'processes')} across ${plural(names.length, 'worktree', 'worktrees')}.`);
  sub('isolated-DB Supabase containers are left running — stop one with `pnpm worktree stop <n>`');
}

/**
 * Tear down ONE worktree (stack, optional isolated Supabase, git worktree,
 * branch, slot). The confirmation and multi-name loop live in `cmdNuke`.
 */
async function nukeOne(name: string, e: SlotEntry, flags: Record<string, string | boolean>): Promise<void> {
  const pid = e.projectId;
  const dbMode = dbModeOf(e);
  step(`Nuking "${name}" ${pc.dim(dbMode === 'isolated' ? '(project ' + pid + ')' : `(${dbLabel(dbMode, name)})`)}`);
  const stopped = await stopStack(e);
  // A process whose cwd is still inside the checkout keeps the directory busy, so
  // an unverified kill here surfaces later as a confusing `git worktree remove` failure.
  if (stopped.survived.length) warn(`${plural(stopped.survived.length, 'process', 'processes')} survived (${stopped.survived.join(', ')}) — removal may fail`);
  if (dbMode === 'isolated') {
    await removeIsolatedSupabase(name, pid);
  } else if (dbMode === 'branch') {
    const db = primaryDb(primaryCredsFromStatus(primarySupabaseStatusEnv(repoRoot())).dbUrl);
    const err = db ? dropBranchDb(db, name) : 'the primary Supabase is not running';
    if (err) warn(`${branchDbName(name)} not dropped (${err}) — drop it later: psql postgresql://postgres:postgres@127.0.0.1:${SHARED_SUPABASE_PORTS.sbDb}/postgres -c 'drop database ${branchDbName(name)} with (force)'`);
    else sub(`dropped database ${branchDbName(name)}`);
  } else {
    sub('shared primary Supabase left untouched');
  }
  const root = repoRoot();
  // Throws when the checkout is dirty and --force was not passed. That must abort
  // the nuke: everything below (branch delete, slot dir, registry entry) assumes
  // the worktree is gone, and dropping the slot for a directory that survived
  // orphans it beyond the reach of every `pnpm worktree` command.
  if (existsSync(e.path)) {
    // A dev server rewrites NOISE_PATHS; that change alone must not block removal.
    const noise = probeCheckout(e.path).noise;
    if (noise.length) sh(['git', '-C', e.path, 'checkout', '--', ...noise]);
    sub('removing git worktree…');
    removeWorktree(root, e.path, Boolean(flags.force));
  }
  sh(['git', '-C', root, 'worktree', 'prune']);
  if (e.branch) {
    const del = sh(['git', '-C', root, 'branch', '-d', e.branch]);
    if (del.ok) sub(`deleted branch "${e.branch}"`);
    // --force drops a branch only when every commit on it also exists on a remote.
    // A branch with unpushed commits is the only copy of that work: 2026-11-05 a
    // `nuke --force` deleted a 60-commit branch that had never been pushed.
    // Autoclean passes `branch-pushed`: it drops the branch on the same rule, without --force's worktree removal.
    else if ((flags.force || flags['branch-pushed']) && sh(['git', '-C', root, 'rev-list', '--count', e.branch, '--not', '--remotes']).stdout.trim() === '0') {
      sh(['git', '-C', root, 'branch', '-D', e.branch]); sub(`force-deleted branch "${e.branch}" (had unmerged commits, all pushed)`);
    }
    // Autoclean passes `branch-merged` when the branch's PR is merged (or its every change is in origin/dev).
    else if (flags['branch-merged']) { sh(['git', '-C', root, 'branch', '-D', e.branch]); sub(`deleted branch "${e.branch}" (merged into dev)`); }
    else if (flags.force) sub(`kept branch "${e.branch}": it has commits on no remote. Push it, or run \`git branch -D ${e.branch}\` to drop them`);
    else sub(`kept branch "${e.branch}" (unmerged commits) — \`git branch -D ${e.branch}\` or \`nuke --force\` to drop it`);
  }
  try { rmSync(slotDir(name), { recursive: true, force: true }); } catch {}
  await withLock(() => { const r = loadRegistry(); delete r.slots[name]; saveRegistry(r); });
  ok(`removed "${name}" — slot ${e.slot} freed.`);
}

/**
 * `nuke <n> [n…] [--force] [--yes]` — destructive, so every target is confirmed
 * individually in a TTY (answer no to skip one, Ctrl+C/Esc to stop the rest).
 * `--yes` or a non-TTY stdin keeps the old non-interactive behavior for scripts.
 */
/**
 * What a checkout's git state says about it. Impure: runs `git` with
 * --no-optional-locks so the probe never refreshes the index (a refreshed
 * index used to read as "active 1m ago").
 */
interface CheckoutProbe {
  /** changed tracked + untracked (non-ignored) files that are not NOISE_PATHS. */
  meaningful: string[];
  /** NOISE_PATHS entries with a change, restorable with `git checkout --`. */
  noise: string[];
  headCommitMs: number | null;
  /** commits on HEAD (and the registered branch) that no remote ref contains; null when unknown. */
  unpushed: number | null;
  changedMtimesMs: number[];
}
const git = (path: string, ...args: string[]) => sh(['git', '--no-optional-locks', '-C', path, ...args]);
function probeCheckout(path: string, branch?: string): CheckoutProbe {
  const entries = parsePorcelain(git(path, 'status', '--porcelain').stdout);
  const meaningful = meaningfulChanges(entries);
  const noise = entries.filter((x) => isNoise(x.path) && x.xy !== '??').map((x) => x.path);
  const changedMtimesMs: number[] = [];
  for (const x of meaningful.slice(0, 500)) {
    try { changedMtimesMs.push(statSync(joinPath(path, x.path)).mtimeMs); } catch {}
  }
  const head = Number(git(path, 'log', '-1', '--format=%ct').stdout.trim());
  const refs = ['HEAD', ...(branch && git(path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok ? [`refs/heads/${branch}`] : [])];
  const up = git(path, 'rev-list', '--count', ...refs, '--not', '--remotes');
  const unpushed = up.ok && /^\d+$/.test(up.stdout.trim()) ? Number(up.stdout.trim()) : null;
  return {
    meaningful: meaningful.map((x) => x.path), noise,
    headCommitMs: Number.isFinite(head) && head > 0 ? head * 1000 : null,
    unpushed, changedMtimesMs,
  };
}

/** Snapshot one registry slot for the `nuke --all` selector. */
function pruneCandidate(name: string, e: SlotEntry, live: Set<number> | null): PruneCandidate {
  const isLive = live ? live.has(e.ports.web) || live.has(e.ports.api) : e.status === 'running';
  const missing = !existsSync(e.path);
  if (missing) return { name, live: isLive, dirty: false, missing, createdAt: e.createdAt, lastActivity: null };
  const p = probeCheckout(e.path, e.branch);
  return {
    name, live: isLive, dirty: p.meaningful.length > 0, missing, createdAt: e.createdAt,
    lastActivity: lastActivity({ createdAt: e.createdAt, lastUsedAt: e.lastUsedAt, headCommitMs: p.headCommitMs, changedMtimesMs: p.changedMtimesMs }),
  };
}

/**
 * `nuke --all [--older-than <dur>] [--idle <dur>] [--include-dirty] [--dry-run]`
 * — bulk teardown. Running stacks are never touched; checkouts with
 * uncommitted tracked changes are kept unless --include-dirty; slots whose
 * directory is already gone are always freed. Local branches survive as usual
 * (`git branch -d` only, unless --force).
 */
async function cmdNukeAll(a: Args) {
  const reg = loadRegistry();
  const names = Object.keys(reg.slots);
  if (!names.length) { ok('no worktrees registered — nothing to nuke'); return; }
  const rule = {
    olderThanMs: typeof a.flags['older-than'] === 'string' ? parseDuration(a.flags['older-than']) : undefined,
    idleMs: typeof a.flags.idle === 'string' ? parseDuration(a.flags.idle) : undefined,
    includeDirty: !!a.flags['include-dirty'],
  };
  step(`Scanning ${plural(names.length, 'worktree', 'worktrees')}`);
  const live = listenPorts();
  const candidates = names.map((n) => pruneCandidate(n, reg.slots[n], live));
  const verdicts = selectForPrune(candidates, rule, Date.now());
  const keep = verdicts.filter((v) => !v.nuke);
  const nuke = verdicts.filter((v) => v.nuke);
  for (const v of keep) sub(`${pc.dim('keep')} ${pc.bold(v.name)} ${pc.dim('— ' + v.why)}`);
  for (const v of nuke) sub(`${pc.red('nuke')} ${pc.bold(v.name)} ${pc.dim('— ' + v.why)}`);
  console.log();
  if (!nuke.length) { ok(`nothing selected (${keep.length} kept)`); return; }
  if (a.flags['dry-run']) { ok(`dry run: would nuke ${nuke.length}, keep ${keep.length}`); return; }
  const confirm = !!process.stdin.isTTY && !!process.stdout.isTTY && !a.flags.yes;
  if (confirm) {
    const v = await clack.confirm({ message: `Nuke ${pc.bold(String(nuke.length))} worktrees and keep ${keep.length}?`, initialValue: false });
    if (clack.isCancel(v) || !v) { clack.cancel('Cancelled — nothing was touched.'); return; }
  }
  let done = 0;
  const failed: string[] = [];
  for (const v of nuke) {
    try { await nukeOne(v.name, reg.slots[v.name], a.flags); done++; }
    catch (err: any) { failed.push(v.name); warn(`"${v.name}" failed: ${err?.message ?? err}`); }
  }
  ok(`nuked ${done}/${nuke.length} · kept ${keep.length}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`);
  if (failed.length) process.exit(1);
}

async function cmdNuke(a: Args) {
  if (a.flags.all) return cmdNukeAll(a);
  const names = (a.names.length ? a.names : [need(a.name)]).map(sanitizeName);
  const reg = loadRegistry();
  const targets: { name: string; e: SlotEntry }[] = [];
  let missed = false;
  for (const n of names) {
    const e = reg.slots[n];
    if (!e) { warn(`unknown worktree "${n}" — skipped`); missed = true; continue; }
    targets.push({ name: n, e });
  }
  if (!targets.length) die('nothing to nuke');
  const confirm = !!process.stdin.isTTY && !!process.stdout.isTTY && !a.flags.yes;
  if (confirm && targets.length > 1) {
    sub(`${plural(targets.length, 'worktree', 'worktrees')} queued: ${targets.map((t) => t.name).join(', ')} — each one is confirmed before it is nuked.`);
  }
  for (const { name, e } of targets) {
    if (confirm) {
      const v = await clack.confirm({
        message: `Nuke ${pc.bold(name)}? ${pc.dim(`slot ${e.slot} · ${dbLabel(dbModeOf(e))} · branch "${e.branch}" — stops its stack, removes ${e.path}`)}`,
        initialValue: false,
      });
      if (clack.isCancel(v)) { clack.cancel('Cancelled — the remaining worktrees were left untouched.'); break; }
      if (!v) { sub(`skipped "${name}"`); continue; }
    }
    await nukeOne(name, e, a.flags);
  }
  if (missed) process.exit(1);
}

/**
 * `list [name] [--json]` — read-only. It never writes the registry, so a status
 * that disagrees with the probe is reported, not repaired; `doctor` owns repair.
 */
function cmdList(a: Args) {
  const reg = loadRegistry();
  const total = Object.keys(reg.slots).length;
  const live = listenPorts();
  const probed = live !== null;
  const all = sortRows(buildRows(reg, live));
  const rows = a.name ? filterRows(all, a.name) : all;

  if (a.flags.json) { console.log(JSON.stringify(toJsonRows(rows, { probed }), null, 2)); return; }
  if (!total) { console.log(`\n  ${pc.dim('No worktrees.')} Create one: ${pc.cyan('pnpm worktree create')}`); return; }
  if (!rows.length) {
    console.log(`\n  ${pc.dim(`No worktree matches "${a.name}".`)} See all: ${pc.cyan('pnpm worktree list')}\n`);
    return;
  }

  // One hit for an explicit query is a lookup, not a list — show the full URLs
  // rather than making you widen the match to read them.
  const lines = a.name && rows.length === 1
    ? renderDetail(rows[0]!, { probed })
    : renderRail(rows, { probed, columns: process.stdout.columns, totalCount: total });
  console.log('');
  for (const l of lines) console.log(l);
  console.log('');
}

function cmdStatus(a: Args) {
  const reg = loadRegistry();
  const names = a.name ? [sanitizeName(a.name)] : Object.keys(reg.slots);
  if (!names.length) { console.log(`\n  ${pc.dim('No worktrees.')}`); return; }
  const procTables = { rows: psTable(), cwds: cwdTable() };
  for (const n of names) {
    const e = reg.slots[n];
    if (!e) { warn(`${n}: unknown`); continue; }
    const dbMode = dbModeOf(e);
    const sb = dbMode === 'isolated'
      ? sh([supabaseBin(), '--workdir', supaWorkdir(n), 'status']).ok
      : portInUse(SHARED_SUPABASE_PORTS.sbApi).inUse;
    const procs = stackPids(e.path, e.ports.api, procTables).length;
    console.log(`\n${pc.bold(n)}  ${pc.dim(`(slot ${e.slot} · ${e.status} · ${dbMode})`)}  ${pc.dim(e.path)}`);
    console.log(`  procs  ${dot(procs > 0)} ${procs ? plural(procs, 'process', 'processes') : pc.dim('none')}`);
    console.log(`  web    ${dot(portInUse(e.ports.web).inUse)} :${e.ports.web}    api ${dot(portInUse(e.ports.api).inUse)} :${e.ports.api}`);
    if (dbMode === 'isolated') console.log(`  supa   ${dot(sb)} db :${e.ports.sbDb}  studio :${e.ports.sbStudio}  inbucket :${e.ports.sbInbucket}`);
    else console.log(`  supa   ${dot(sb)} shared db :${SHARED_SUPABASE_PORTS.sbDb}${dbMode === 'branch' ? '/' + branchDbName(n) : ''}  studio :${SHARED_SUPABASE_PORTS.sbStudio}  inbucket :${SHARED_SUPABASE_PORTS.sbInbucket}`);
  }
  console.log('');
}

/**
 * `sweep [--idle 60m] [--yes]` — delete build output (ARTIFACT_DIRS) in every
 * git worktree of this repo, registered or not, that has no process inside it
 * and no file written within --idle. Tracked dirs (packages/ui/dist) are kept.
 * Without --yes it only reports. The next `pnpm dev` / build regenerates it.
 */
function gitWorktreePaths(): string[] {
  return sh(['git', '-C', repoRoot(), 'worktree', 'list', '--porcelain']).stdout
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
}
/** `find` inside one checkout, skipping node_modules, .git and nested worktrees (.claude/worktrees/*). */
function findIn(wt: string, wts: string[], ...test: string[]): string[] {
  const nested = wts.filter((o) => o !== wt && o.startsWith(`${wt}/`)).flatMap((o) => ['-path', o, '-prune', '-o']);
  return sh(['find', wt, ...nested, '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o', ...test]).stdout
    .split('\n').filter(Boolean);
}
/** ARTIFACT_DIRS in one checkout, minus anything under a src/ dir and any dir that holds a tracked file. */
function artifactDirs(wt: string, wts: string[]): string[] {
  return findIn(wt, wts, '-type', 'd', '(', ...ARTIFACT_DIRS.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')', '-prune', '-print')
    .filter((d) => !d.slice(wt.length).includes('/src/'))
    .filter((d) => !sh(['git', '-C', wt, 'ls-files', '--', d]).stdout.trim());
}
const recentWrite = (dir: string, minutes: number) => sh(['find', dir, '-type', 'f', '-mmin', `-${minutes}`, '-print', '-quit']).stdout.trim() !== '';
const duKb = (d: string) => Number(sh(['du', '-sk', d]).stdout.split('\t')[0]) || 0;
const gbOf = (kb: number) => fmtKb(kb);

function cmdSweep(a: Args) {
  const idleMin = Math.ceil(parseDuration(typeof a.flags.idle === 'string' ? a.flags.idle : '60m') / 60_000);
  const wts = gitWorktreePaths();
  const cwds = cwdTable().map((r) => r.cwd);
  const commands = psTable().map((r) => r.command);
  step(`Sweeping ${plural(wts.length, 'worktree', 'worktrees')} (idle ≥ ${idleMin}m)`);
  let kb = 0, dirs = 0, busy = 0;
  for (const wt of wts) {
    if (!existsSync(wt)) continue;
    if (sweepBusy(wt, cwds, commands) || findIn(wt, wts, '-type', 'f', '-mmin', `-${idleMin}`, '-print', '-quit').length) { busy++; continue; }
    for (const d of artifactDirs(wt, wts)) {
      const size = duKb(d);
      if (a.flags.yes) {
        if (recentWrite(d, idleMin)) continue;
        rmSync(d, { recursive: true, force: true });
      }
      kb += size; dirs++;
      if (size > 1_048_576) sub(`${(size / 1_048_576).toFixed(1)} GB  ${d}`);
    }
  }
  const gb = (kb / 1_048_576).toFixed(1);
  ok(a.flags.yes
    ? `deleted ${plural(dirs, 'dir', 'dirs')}, ${gb} GB · skipped ${busy} busy`
    : `dry run: ${plural(dirs, 'dir', 'dirs')}, ${gb} GB · ${busy} busy · pass --yes to delete`);
}

/** The primary checkout: the directory that holds the shared `.git`. */
function primaryRoot(): string {
  const common = sh(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  return common ? dirname(common) : repoRoot();
}

const AUTOCLEAN_LOCK = joinPath(WT_HOME, 'autoclean.lock');
const AUTOCLEAN_LOCK_STALE_MS = 15 * 60_000;
/** One autoclean at a time on the box. A second caller skips instead of waiting. */
function tryAutocleanLock(): (() => void) | null {
  const acquire = () => {
    const fd = openSync(AUTOCLEAN_LOCK, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return () => { try { rmSync(AUTOCLEAN_LOCK, { force: true }); } catch {} };
  };
  try { return acquire(); } catch { /* held, or stale: break a stale lock below */ }
  try {
    breakStaleAutocleanLock();
    return acquire();
  } catch { return null; }
}
/**
 * Removes the autoclean lock only when it is older than 15 min. Never
 * stat-then-delete by path: another caller can break and re-take the lock in
 * between, and the delete would remove its fresh lock. The age is read from an
 * open descriptor, the lock is moved aside with one atomic rename, and the moved
 * file is deleted only when it is the same inode that was found stale. A fresh
 * lock moved by mistake is linked back.
 */
function breakStaleAutocleanLock(): void {
  const fd = openSync(AUTOCLEAN_LOCK, 'r');
  let ino: number;
  try {
    const st = fstatSync(fd);
    if (Date.now() - st.mtimeMs <= AUTOCLEAN_LOCK_STALE_MS) return;
    ino = st.ino;
  } finally { closeSync(fd); }
  const moved = `${AUTOCLEAN_LOCK}.stale-${process.pid}`;
  renameSync(AUTOCLEAN_LOCK, moved);
  const movedFd = openSync(moved, 'r');
  try {
    if (fstatSync(movedFd).ino !== ino) { try { linkSync(moved, AUTOCLEAN_LOCK); } catch {} }
  } finally { closeSync(movedFd); }
  rmSync(moved, { force: true });
}

/** A checkout autoclean may touch: a registry slot, or a Claude Code isolation worktree. */
interface Checkout {
  kind: 'slot' | 'claude';
  /** slot name, or `claude:<id>`. */
  name: string;
  path: string;
  branch?: string;
  entry?: SlotEntry;
  lock: LockState;
}
interface AutocleanPlan {
  verdict: AutocleanVerdict;
  checkout: Checkout;
  sweepDirs: string[];
  sweepKb: number;
  cap: CapVerdict[];
  unpushed: number | null;
  merged: boolean;
}
interface BranchPlan { name: string; remove: boolean; why: string }
interface FullPlan {
  pass: AutocleanPass;
  freeBytes: number | null;
  plans: AutocleanPlan[];
  branches: BranchPlan[];
  trims: CacheTrim[];
  trimsBlocked: boolean;
}

const MERGED_CACHE = joinPath(WT_HOME, 'merged-prs.json');
const MERGED_CACHE_TTL_MS = 10 * 60_000;
let mergedIdx: Map<string, MergedPr[]> | null | undefined;
/**
 * Recently merged PRs of the repo, by head branch: one `gh` call (~6 s for
 * 500 PRs), cached for 10 minutes so `create`/`start` rarely pay it. Null when
 * `gh` is missing, signed out or offline: callers fall back to git.
 */
function mergedPrs(root: string): Map<string, MergedPr[]> | null {
  if (mergedIdx !== undefined) return mergedIdx;
  try {
    // Age and content from one descriptor: a stat-then-read by path could read
    // a cache another process replaced in between (CodeQL js/file-system-race).
    const fd = openSync(MERGED_CACHE, 'r');
    try {
      if (Date.now() - fstatSync(fd).mtimeMs < MERGED_CACHE_TTL_MS) return (mergedIdx = mergedPrIndex(readFileSync(fd, 'utf8')));
    } finally { closeSync(fd); }
  } catch {}
  if (!which('gh')) return (mergedIdx = null);
  const r = sh(['gh', 'pr', 'list', '--state', 'merged', '--limit', '500', '--json', 'number,headRefName,headRefOid'], { cwd: root });
  if (!r.ok) return (mergedIdx = null);
  // Write aside and rename into place: a reader never sees a half-written
  // cache, and the write never races the read above (CodeQL js/file-system-race).
  try {
    const tmp = `${MERGED_CACHE}.${process.pid}.tmp`;
    writeFileSync(tmp, r.stdout);
    renameSync(tmp, MERGED_CACHE);
  } catch {}
  return (mergedIdx = mergedPrIndex(r.stdout));
}

/**
 * Every file the branch changed (merge-base..tip) is identical in origin/dev:
 * merging it would change nothing. Catches a squash merge when `gh` is not
 * available. Rename detection is off (it costs minutes on old branches).
 */
function treeInDev(root: string, tip: string): boolean {
  const mb = sh(['git', '-C', root, 'merge-base', 'origin/dev', tip]).stdout.trim();
  if (!mb) return false;
  const files = sh(['git', '-C', root, 'diff', '--no-renames', '--name-only', '-z', mb, tip]).stdout.split('\0').filter(Boolean);
  if (!files.length) return true;
  if (files.length > 2000) return false;
  const ls = (ref: string) => sh(['git', '-C', root, 'ls-tree', '-r', '--full-tree', ref, '--', ...files]);
  const a = ls('origin/dev'), b = ls(tip);
  return a.ok && b.ok && a.stdout === b.stdout;
}

/**
 * Is the work on `tip` in dev? In order: the tip is an ancestor of origin/dev;
 * a merged PR for `branch` covers the tip (`prCovering`); without `gh`, every
 * changed file matches origin/dev (`treeInDev`, only when the branch has
 * commits on no remote).
 */
function branchMerged(root: string, branch: string | undefined, tip: string | undefined, unpushed: number | null): boolean {
  if (!tip) return false;
  if (sh(['git', '-C', root, 'merge-base', '--is-ancestor', tip, 'origin/dev']).ok) return true;
  const idx = mergedPrs(root);
  if (idx) {
    if (!branch) return false;
    return prCovering(idx.get(branch), tip, (oid) => {
      if (!sh(['git', '-C', root, 'cat-file', '-e', `${oid}^{commit}`]).ok) return null;
      const r = sh(['git', '-C', root, 'rev-list', '--count', tip, '--not', oid, '--remotes']);
      return r.ok && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
    }) !== null;
  }
  return unpushed !== 0 && treeInDev(root, tip);
}

/** Start time of a live pid (Linux /proc), undefined when alive but unknowable, null when gone. Signal 0 only probes. */
function procStart(pid: number): string | null | undefined {
  try { process.kill(pid, 0); } catch (e: any) { return e?.code === 'EPERM' ? undefined : null; }
  try { return procStatStart(readFileSync(`/proc/${pid}/stat`, 'utf8')) ?? undefined; } catch { return undefined; }
}

const mtimeMs = (p: string) => { try { return statSync(p).mtimeMs; } catch { return NaN; } };
const isoOr = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

function freeBytesOf(dir: string): number | null {
  return parseDfFreeBytes(sh(['df', '-Pk', dir]).stdout);
}

/** Build output dirs of one checkout, with size, for the cap rule. `skip` = dirs already being swept. */
function capDirsOf(path: string, wts: string[], cwds: string[], commands: string[], capBytes: number, skip: Set<string>): CapDir[] {
  return artifactDirs(path, wts).filter((d) => !skip.has(d)).map((d) => {
    const kb = duKb(d);
    const over = kb * 1024 > capBytes;
    return { dir: d, kb, recentWrite: over && recentWrite(d, RECENT_WRITE_MIN), pkgBusy: over && sweepBusy(capOwnerDir(d), cwds, commands) };
  });
}

/**
 * Probe every registry slot and every Claude Code isolation worktree, and
 * decide. Never touches the primary checkout, a worktree git does not list,
 * or a git worktree outside the registry and `<primary>/.claude/worktrees/`
 * (scratchpad checkouts).
 */
function planAutoclean(cfg: AutocleanConfig, current: string | undefined, measure: boolean): FullPlan {
  const reg = loadRegistry();
  const primary = primaryRoot();
  const freeBytes = freeBytesOf(dirname(primary));
  const pass = autocleanPass(cfg, freeBytes);
  const live = listenPorts();
  const ps = psTable();
  const cwds = cwdTable().map((r) => r.cwd);
  const commands = ps.map((r) => r.command);
  const gitWts = parseWorktreePorcelain(sh(['git', '-C', primary, 'worktree', 'list', '--porcelain']).stdout);
  const wts = gitWts.map((w) => w.path);
  const now = Date.now();
  const commonDir = joinPath(primary, '.git');

  const checkouts: Checkout[] = Object.entries(reg.slots).map(([name, e]) => ({ kind: 'slot', name, path: e.path, branch: e.branch, entry: e, lock: 'none' }));
  for (const w of gitWts) {
    if (!isClaudeWorktree(w.path, primary) || checkouts.some((c) => c.path === w.path)) continue;
    checkouts.push({ kind: 'claude', name: `claude:${basename(w.path)}`, path: w.path, branch: w.branch, lock: lockState(w.locked, procStart) });
  }

  const plans: AutocleanPlan[] = [];
  for (const co of checkouts) {
    const e = co.entry;
    const missing = !existsSync(co.path);
    const listed = wts.includes(co.path);
    const probe = missing || !listed ? null : probeCheckout(co.path, co.branch);
    let activity: number | null;
    if (co.kind === 'slot') {
      activity = lastActivity({ createdAt: e!.createdAt, lastUsedAt: e!.lastUsedAt, headCommitMs: probe?.headCommitMs, changedMtimesMs: probe?.changedMtimesMs });
    } else {
      // No registry: the worktree's admin dir (HEAD, index, lock) changes when the agent works in it.
      const admin = joinPath(commonDir, 'worktrees', basename(co.path));
      const touched = Math.max(mtimeMs(admin), mtimeMs(joinPath(admin, 'HEAD')), mtimeMs(joinPath(admin, 'locked')));
      activity = lastActivity({ lastUsedAt: isoOr(touched), headCommitMs: probe?.headCommitMs, changedMtimesMs: probe?.changedMtimesMs });
    }
    const unpushed = probe ? probe.unpushed : 0;
    const cand: AutocleanCandidate = {
      name: co.name,
      primary: co.path.replace(/\/+$/, '') === primary,
      live: e ? (live ? live.has(e.ports.web) || live.has(e.ports.api) : e.status === 'running') : false,
      busy: (!missing && sweepBusy(co.path, cwds, commands)) || co.lock === 'agent-running' || co.lock === 'other',
      missing,
      unregistered: !missing && !listed,
      meaningfulChanges: probe?.meaningful.length ?? 0,
      unpushed,
      lastActivity: activity,
      current: co.kind === 'slot' && co.name === current,
    };
    // Merge detection costs git (and maybe one gh call): only ask when it can change the verdict.
    const idle = activity === null ? 0 : now - activity;
    const mayRemove = probe && !cand.live && !cand.busy && cand.meaningfulChanges === 0 && idle >= pass.mergedRemoveIdleMs;
    cand.merged = mayRemove ? branchMerged(primary, co.branch, sh(['git', '-C', co.path, 'rev-parse', 'HEAD']).stdout.trim() || undefined, unpushed) : false;
    const verdict = decideAutoclean(cand, pass, now);
    const lockReason = co.kind === 'claude' ? gitWts.find((w) => w.path === co.path)?.locked : undefined;
    if (co.lock === 'agent-running') verdict.why = 'Claude agent still running (worktree lock)';
    if (co.lock === 'other') verdict.why = `locked by a person (${lockReason || 'no reason given'})`;
    const sweepDirs = verdict.sweep ? artifactDirs(co.path, wts) : [];
    if (verdict.sweep && !sweepDirs.length) { verdict.sweep = false; verdict.why = verdict.why.replace(/ — sweep build output$/, ' — no build output to sweep'); }
    const sweepKb = measure ? sweepDirs.reduce((n, d) => n + duKb(d), 0) : 0;
    const cap = verdict.remove || missing || !listed || cand.primary
      ? []
      : decideCap({ primary: cand.primary, live: cand.live }, capDirsOf(co.path, wts, cwds, commands, cfg.capBytes, new Set(sweepDirs)), cfg.capBytes);
    plans.push({ verdict, checkout: co, sweepDirs, sweepKb, cap, unpushed, merged: !!cand.merged });
  }

  // Leftover worktree-agent-* branches: one rev-list finds every one that holds a commit on no remote.
  const checkedOut = new Set(gitWts.map((w) => w.branch).filter(Boolean) as string[]);
  const agentBranches = sh(['git', '-C', primary, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/worktree-agent-*']).stdout
    .split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]);
  const unpushedTips = new Set(agentBranches.length
    ? sh(['git', '-C', primary, 'rev-list', '--branches=worktree-agent-*', '--not', '--remotes']).stdout.split('\n').filter(Boolean)
    : []);
  const branches = agentBranches.map(([name, tip]) => {
    const isOut = checkedOut.has(name);
    const unp = unpushedTips.has(tip) ? 1 : 0;
    const merged = !isOut && unp > 0 ? branchMerged(primary, name, tip, unp) : false;
    const d = decideBranch({ name, checkedOut: isOut, unpushed: unp, merged });
    return d.remove || d.why !== `${unp} commit(s) on no remote` ? d : { ...d, why: 'commits on no remote, not merged' };
  });

  const trims = pass.pressure ? cacheTrims((bin) => !!which(bin)) : [];
  return { pass, freeBytes, plans, branches, trims, trimsBlocked: pass.pressure && installRunning(commands) };
}

/** Run `fn` with console.log captured; replay the lines only when it throws. */
async function quietly(fn: () => Promise<void>): Promise<void> {
  const lines: unknown[][] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args); };
  try { await fn(); } catch (err) { console.log = log; for (const l of lines) log(...l); throw err; } finally { console.log = log; }
}

/**
 * Remove one Claude Code isolation worktree. A lock left by an agent that no
 * longer runs is lifted first; `git worktree remove` without --force refuses
 * a checkout with changes, so real work can never go. The branch goes too
 * when its commits are on a remote or merged.
 */
function removeClaudeWorktree(p: AutocleanPlan): void {
  const root = primaryRoot();
  const { path, branch } = p.checkout;
  const noise = probeCheckout(path).noise;
  if (noise.length) sh(['git', '-C', path, 'checkout', '--', ...noise]);
  if (p.checkout.lock === 'agent-gone') sh(['git', '-C', root, 'worktree', 'unlock', path]);
  removeWorktree(root, path, false);
  sh(['git', '-C', root, 'worktree', 'prune']);
  if (!branch) return;
  if (!sh(['git', '-C', root, 'branch', '-d', branch]).ok && (p.merged || p.unpushed === 0)) sh(['git', '-C', root, 'branch', '-D', branch]);
}

const gbs = (bytes: number | null) => (bytes === null ? '?' : fmtKb(bytes / 1024));

/**
 * Sweep build output (idle ≥ sweepIdle, any idle under pressure), delete
 * build output over the cap in stopped checkouts, remove clean pushed or
 * merged worktrees and Claude isolation worktrees idle past the threshold,
 * delete leftover worktree-agent-* branches, and under pressure trim the
 * machine caches. `auto` mode runs inside create/start and on the schedule:
 * it acts without asking and prints one summary line, or nothing.
 */
async function runAutoclean(opts: { mode: 'auto' | 'explicit'; dryRun: boolean; current?: string; stamp?: boolean }): Promise<void> {
  const { config, warnings } = autocleanConfig(process.env);
  for (const w of warnings) warn(w);
  if (opts.mode === 'auto' && !config.enabled) return;
  const release = tryAutocleanLock();
  if (!release) { if (opts.mode === 'explicit') warn('another autoclean is running — skipped'); return; }
  try {
    const explicit = opts.mode === 'explicit';
    if (explicit) step(`Autoclean: sweep build output idle ≥ ${fmtMs(config.sweepIdleMs)}, cap build output at ${gbs(config.capBytes)}, remove clean pushed worktrees idle ≥ ${fmtMs(config.removeIdleMs)} (merged ≥ ${fmtMs(config.mergedRemoveIdleMs)})${opts.dryRun ? pc.dim(' (dry run)') : ''}`);
    const plan = planAutoclean(config, opts.current, explicit);
    const { plans, pass } = plan;
    if (explicit) {
      sub(pass.pressure
        ? pc.yellow(`disk pressure: ${gbs(plan.freeBytes)} free < ${gbs(config.pressureFreeBytes)} — sweep every stopped checkout, remove idle ≥ ${fmtMs(pass.removeIdleMs)}, trim caches`)
        : `disk: ${gbs(plan.freeBytes)} free (pressure mode below ${gbs(config.pressureFreeBytes)})`);
      for (const p of plans) {
        const tag = p.verdict.remove ? pc.red('remove') : p.verdict.sweep ? pc.yellow('sweep ') : pc.dim('keep  ');
        const size = p.verdict.sweep ? pc.dim(` · ${gbOf(p.sweepKb)} in ${plural(p.sweepDirs.length, 'dir', 'dirs')}`) : '';
        sub(`${tag} ${pc.bold(p.verdict.name)} ${pc.dim('— ' + p.verdict.why)}${size}`);
        for (const c of p.cap) sub(`  ${c.remove ? pc.red('cap   ') : pc.dim('cap   ')} ${c.dir.slice(p.checkout.path.length + 1)} ${pc.dim('— ' + c.why)}`);
      }
      const del = plan.branches.filter((b) => b.remove);
      const kept = plan.branches.filter((b) => !b.remove);
      if (plan.branches.length) {
        sub(`branches: delete ${plural(del.length, 'worktree-agent-* branch', 'worktree-agent-* branches')}${del.length ? pc.dim(` (${del.slice(0, 5).map((b) => b.name).join(', ')}${del.length > 5 ? ', …' : ''})`) : ''}`);
        const why = new Map<string, number>();
        for (const b of kept) why.set(b.why, (why.get(b.why) ?? 0) + 1);
        for (const [w, n] of why) sub(`          keep ${n} ${pc.dim('— ' + w)}`);
      }
      if (plan.trims.length) sub(`caches: ${plan.trimsBlocked ? pc.dim('skipped — a package install or go build is running') : plan.trims.map((t) => t.label).join(' · ')}`);
    }
    const toSweep = plans.filter((p) => p.verdict.sweep);
    const toRemove = plans.filter((p) => p.verdict.remove);
    const toCap = plans.flatMap((p) => p.cap.filter((c) => c.remove).map((c) => ({ p, c })));
    const toBranch = plan.branches.filter((b) => b.remove);
    if (opts.dryRun) {
      ok(`dry run: would sweep ${plural(toSweep.length, 'checkout', 'checkouts')} (${gbOf(toSweep.reduce((n, p) => n + p.sweepKb, 0))}), cap ${plural(toCap.length, 'dir', 'dirs')} (${gbOf(toCap.reduce((n, x) => n + x.c.kb, 0))}), remove ${plural(toRemove.length, 'worktree', 'worktrees')}, delete ${plural(toBranch.length, 'branch', 'branches')}${plan.trims.length && !plan.trimsBlocked ? `, trim ${plural(plan.trims.length, 'cache', 'caches')}` : ''}, keep ${plans.length - toSweep.length - toRemove.length}`);
      return;
    }
    const trim = plan.trims.length > 0 && !plan.trimsBlocked;
    if (!toSweep.length && !toRemove.length && !toCap.length && !toBranch.length && !trim) { if (explicit) ok('nothing to clean'); return; }

    // Re-probe right before acting: a session may have started since the scan.
    const live = listenPorts();
    const cwds = cwdTable().map((r) => r.cwd);
    const commands = psTable().map((r) => r.command);
    const nowBusy = (co: Checkout) =>
      (co.entry && live ? live.has(co.entry.ports.web) || live.has(co.entry.ports.api) : false) ||
      (existsSync(co.path) && sweepBusy(co.path, cwds, commands));
    const sweepMin = Math.max(RECENT_WRITE_MIN, Math.ceil(pass.sweepIdleMs / 60_000));
    let swept = 0, sweptKb = 0, capped = 0, removed = 0, branchesDeleted = 0;
    const failed: string[] = [];
    for (const p of toSweep) {
      if (nowBusy(p.checkout)) continue;
      let n = 0;
      for (const d of p.sweepDirs) {
        if (recentWrite(d, sweepMin)) continue;
        sweptKb += duKb(d);
        rmSync(d, { recursive: true, force: true });
        n++;
      }
      if (n) swept++;
    }
    for (const { p, c } of toCap) {
      const co = p.checkout;
      const isLive = co.entry && live ? live.has(co.entry.ports.web) || live.has(co.entry.ports.api) : false;
      if (isLive || !existsSync(c.dir) || sweepBusy(capOwnerDir(c.dir), cwds, commands) || recentWrite(c.dir, RECENT_WRITE_MIN)) continue;
      sweptKb += duKb(c.dir);
      rmSync(c.dir, { recursive: true, force: true });
      capped++;
    }
    for (const p of toRemove) {
      const co = p.checkout;
      if (nowBusy(co)) continue;
      const kb = existsSync(co.path) ? duKb(joinPath(co.path, 'apps/web/.next')) : 0;
      try {
        if (co.kind === 'slot') await quietly(() => nukeOne(co.name, co.entry!, { 'branch-pushed': true, ...(p.merged ? { 'branch-merged': true } : {}) }));
        else {
          const w = parseWorktreePorcelain(sh(['git', '-C', primaryRoot(), 'worktree', 'list', '--porcelain']).stdout).find((x) => x.path === co.path);
          if (!w || lockState(w.locked, procStart) === 'agent-running' || lockState(w.locked, procStart) === 'other') continue;
          removeClaudeWorktree(p);
        }
        removed++; sweptKb += kb;
      } catch (err: any) { failed.push(co.name); warn(`autoclean: "${co.name}" not removed: ${err?.message ?? err}`); }
    }
    const root = primaryRoot();
    for (const b of toBranch) {
      // `git branch -D` refuses a branch a worktree has checked out, so a new checkout since the scan is safe.
      if (sh(['git', '-C', root, 'branch', '-D', b.name]).ok) branchesDeleted++;
    }
    sh(['git', '-C', root, 'worktree', 'prune']);
    const trimmed: string[] = [];
    if (trim && !installRunning(psTable().map((r) => r.command))) {
      for (const t of plan.trims) if (sh(t.argv, { cwd: root }).ok) trimmed.push(t.label);
    }
    const freeAfter = freeBytesOf(dirname(root));
    const parts = [];
    if (swept) parts.push(`swept build output in ${plural(swept, 'checkout', 'checkouts')}`);
    if (capped) parts.push(`deleted ${plural(capped, 'over-cap build dir', 'over-cap build dirs')}`);
    if (removed) parts.push(`removed ${plural(removed, 'idle worktree', 'idle worktrees')} (${toRemove.filter((p) => !failed.includes(p.verdict.name)).map((p) => p.verdict.name).join(', ')})`);
    if (branchesDeleted) parts.push(`deleted ${plural(branchesDeleted, 'worktree-agent-* branch', 'worktree-agent-* branches')}`);
    if (trimmed.length) parts.push(`trimmed ${trimmed.join(', ')}`);
    if (parts.length) {
      const when = opts.stamp ? `${new Date().toISOString()} ` : '';
      const disk = `${gbs(plan.freeBytes)} → ${gbs(freeAfter)} free${pass.pressure ? ' (pressure mode)' : ''}`;
      ok(`${when}autoclean: ${parts.join(', ')} · ≥${gbOf(sweptKb)} build output · disk ${disk}${explicit ? '' : pc.dim(' · KORTIX_WORKTREE_AUTOCLEAN=0 turns this off')}`);
    }
  } finally { release(); }
}

const fmtMs = (ms: number) => (ms % 86_400_000 === 0 && ms > 2 * 86_400_000 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`);

/**
 * Free space on the filesystem that holds the worktrees. Below 10 GB: warn and
 * name the 5 largest registered checkouts. Below 4 GB: `create` exits 2 and
 * `start` only warns (a running stack needs no new checkout).
 */
function diskGuard(cmd: 'create' | 'start'): void {
  const parent = dirname(primaryRoot());
  const free = parseDfFreeBytes(sh(['df', '-Pk', parent]).stdout);
  if (free === null) return;
  const { warnBytes, refuseBytes } = diskThresholds(process.env);
  const level = diskLevel(free, warnBytes, refuseBytes);
  if (level === 'ok') return;
  const freeGb = (free / 1024 ** 3).toFixed(1);
  warn(`${freeGb} GB free on the disk that holds ${parent} (warn < ${+(warnBytes / 1024 ** 3).toFixed(1)} GB, refuse < ${+(refuseBytes / 1024 ** 3).toFixed(1)} GB)`);
  // One du call, primary first: du counts a hardlinked file once, so each
  // worktree is charged only for what it does not share with the ones before it.
  const reg = loadRegistry();
  const paths = Object.values(reg.slots).map((e) => e.path).filter((p) => existsSync(p));
  const sizes = new Map<string, number>();
  for (const line of sh(['du', '-sk', primaryRoot(), ...paths]).stdout.split('\n')) {
    const [kb, path] = line.split('\t');
    if (path) sizes.set(path, Number(kb) || 0);
  }
  const top = paths.map((p) => ({ p, kb: sizes.get(p) ?? 0 })).sort((x, y) => y.kb - x.kb).slice(0, 5);
  for (const t of top) {
    const next = joinPath(t.p, 'apps/web/.next');
    sub(`${gbOf(t.kb).padStart(8)} unshared · .next ${existsSync(next) ? gbOf(duKb(next)) : '0.0 GB'}  ${t.p}`);
  }
  const fix = `free space: ${pc.cyan('pnpm worktree autoclean --yes')} · ${pc.cyan('pnpm worktree sweep --idle 1h --yes')} · ${pc.cyan('pnpm worktree nuke --all --idle 24h --dry-run')}`;
  if (level === 'refuse' && cmd === 'create') {
    console.error(`\n${pc.red('✗')} refusing to create a worktree with ${freeGb} GB free: a new worktree needs ~1.3 GB plus its build output.\n  ${fix}`);
    process.exit(2);
  }
  sub(fix);
}

function readCrontab(): string | null {
  if (!which('crontab')) return null;
  const r = sh(['crontab', '-l']);
  // `crontab -l` exits 1 with "no crontab for <user>" when there is none.
  return r.ok ? r.stdout : '';
}
function writeCrontab(text: string): boolean {
  const tmp = joinPath(WT_HOME, 'crontab.tmp');
  writeFileSync(tmp, text);
  const r = sh(['crontab', tmp]);
  rmSync(tmp, { force: true });
  return r.ok;
}

const KORTIX_HOME_DIR = dirname(WT_HOME);
const BUNDLE = joinPath(KORTIX_HOME_DIR, 'bin', BUNDLE_NAME);
const BUNDLE_STAMP = `${BUNDLE}.json`;
const LOOP_GEN = joinPath(WT_HOME, 'autoclean-loop.gen');
const SCHEDULE_OFF = joinPath(WT_HOME, 'autoclean-schedule.off');
const AUTOCLEAN_LOG = joinPath(WT_HOME, 'autoclean.log');
/** This file's directory: scripts/worktree in a checkout, $KORTIX_HOME/bin in the bundle. */
const SOURCE_DIR = import.meta.dir;
const runningFromBundle = () => !existsSync(joinPath(SOURCE_DIR, 'lib', 'autoclean.ts'));

/** The committed version of scripts/worktree this process runs. */
function runningCode(): RunningCode {
  const [ct, rev] = sh(['git', '-C', SOURCE_DIR, 'log', '-1', '--format=%ct %H', '--', '.']).stdout.trim().split(' ');
  const dirty = sh(['git', '-C', SOURCE_DIR, 'status', '--porcelain', '--', '.']).stdout.trim() !== '';
  const ms = Number(ct) * 1000;
  return { commitMs: Number.isFinite(ms) && ms > 0 ? ms : null, rev: rev ?? '', dirty };
}

/**
 * Bundle this CLI into one file that runs without node_modules, prove it
 * loads from `/`, then move it into place. Returns an error, or null.
 */
function buildBundle(code: RunningCode): string | null {
  mkdirSync(dirname(BUNDLE), { recursive: true });
  const tmp = joinPath(dirname(BUNDLE), `.worktree-autoclean.${process.pid}.js`);
  try {
    const b = sh([process.execPath, 'build', joinPath(SOURCE_DIR, 'cli.ts'), '--target', 'bun', '--outfile', tmp]);
    if (!b.ok) return (b.stderr || b.stdout).trim().split('\n').pop() || 'bun build failed';
    const check = sh([process.execPath, tmp, 'bundle-check'], { cwd: '/' });
    if (!check.ok || !check.stdout.includes('bundle-check ok')) return `the bundle does not run standalone: ${(check.stderr || check.stdout).trim().split('\n').pop()}`;
    renameSync(tmp, BUNDLE);
    const stamp: BundleStamp = { sourceCommitMs: code.commitMs ?? 0, sourceRev: code.rev, dirty: code.dirty, builtAt: new Date().toISOString() };
    writeFileSync(BUNDLE_STAMP, JSON.stringify(stamp, null, 2) + '\n');
    return null;
  } finally { rmSync(tmp, { force: true }); }
}

const cronDaemonRunning = () => psTable().some((r) => /(^|\/)(cron|crond)(\s|$)/.test(r.command));
const scheduleTarget = (): ScheduleTarget => ({
  repo: primaryRoot(), bun: process.execPath, bundle: BUNDLE,
  path: process.env.PATH ?? '/usr/bin:/bin', kortixHome: KORTIX_HOME_DIR, log: AUTOCLEAN_LOG,
});

/** Start the fallback loop in its own session, so it outlives this command and its terminal. */
function spawnLoop(script: string): void {
  const argv = which('setsid') ? ['setsid', '-f', 'sh', '-c', script] : ['nohup', 'sh', '-c', script];
  Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
}

/**
 * Keep the 15-minute schedule installed and current. Rebuilds the bundle when
 * the code running now is newer (`bundleRebuildReason`), then installs the
 * cron line or the fallback loop when it is missing or runs another command.
 * Idempotent; a no-op inside the bundle, with KORTIX_WORKTREE_AUTOCLEAN=0, or
 * after `--uninstall-cron` (unless `force`). Returns what it changed.
 */
function ensureSchedule(force: boolean): { changed: string[]; error?: string; scheduler: Scheduler } {
  const changed: string[] = [];
  const scheduler = pickScheduler({ platform: process.platform, hasCrontab: !!which('crontab'), cronDaemon: cronDaemonRunning(), hasSh: existsSync('/bin/sh') });
  if (runningFromBundle()) return { changed, scheduler };
  if (!force && (!autocleanConfig(process.env).config.enabled || existsSync(SCHEDULE_OFF))) return { changed, scheduler };
  const code = runningCode();
  const stamp = parseStamp(existsSync(BUNDLE_STAMP) ? readFileSync(BUNDLE_STAMP, 'utf8') : null);
  const reason = force ? 'install requested' : bundleRebuildReason(stamp, existsSync(BUNDLE), code);
  if (reason) {
    const err = buildBundle(code);
    if (err) return { changed, error: `bundle build failed: ${err}`, scheduler };
    changed.push(`bundle rebuilt (${reason})`);
  }
  if (!existsSync(BUNDLE)) return { changed, scheduler };
  const target = scheduleTarget();
  if (scheduler === 'cron') {
    const tab = readCrontab() ?? '';
    const line = cronLine(target);
    if (currentCronLine(tab) !== line) {
      if (!writeCrontab(withCronLine(tab, line))) return { changed, error: 'crontab write failed', scheduler };
      changed.push('cron line every 15 min installed');
    }
  } else if (scheduler === 'loop') {
    const cmd = scheduledCommand(target);
    const gen = generationOf(cmd);
    if (!psTable().some((r) => isLoopFor(r.command, gen))) {
      writeFileSync(LOOP_GEN, gen);
      spawnLoop(loopScript({ cmd, genFile: LOOP_GEN, gen }));
      changed.push('background loop every 15 min started (no cron daemon)');
    }
  }
  return { changed, scheduler };
}

/** create/start: keep the schedule current, one line when something changed. Never fails the command. */
function ensureScheduleQuietly(): void {
  try {
    const r = ensureSchedule(false);
    if (r.error) warn(`autoclean schedule: ${r.error}`);
    else if (r.changed.length) sub(`autoclean schedule: ${r.changed.join(', ')} · log ${AUTOCLEAN_LOG}`);
  } catch (err: any) { warn(`autoclean schedule: ${err?.message ?? err}`); }
}

/** The scheduled run's log stays under ~1 MB: the old half moves to autoclean.log.1. */
function rotateLog(): void {
  try { if (statSync(AUTOCLEAN_LOG).size > 1_000_000) renameSync(AUTOCLEAN_LOG, `${AUTOCLEAN_LOG}.1`); } catch {}
}

/**
 * `autoclean [--dry-run] [--yes] [--install-cron | --uninstall-cron]`. Without --yes it is a dry run.
 * `--scheduled` (the cron line / loop) also fetches origin/dev and rotates the log.
 */
async function cmdAutoclean(a: Args) {
  if (a.flags['uninstall-cron']) {
    writeFileSync(SCHEDULE_OFF, new Date().toISOString() + '\n');
    writeFileSync(LOOP_GEN, 'off\n');
    const tab = readCrontab();
    if (tab !== null && hasCronLine(tab) && !writeCrontab(withoutCronLine(tab))) die('crontab write failed');
    ok('autoclean schedule removed: no cron line, and a running loop exits at its next tick (≤ 15 min)');
    sub(`create/start no longer reinstall it · ${pc.cyan('pnpm worktree autoclean --install-cron')} turns it back on`);
    return;
  }
  if (a.flags['install-cron']) {
    if (runningFromBundle()) die('run --install-cron from a checkout: pnpm worktree autoclean --install-cron');
    rmSync(SCHEDULE_OFF, { force: true });
    const r = ensureSchedule(true);
    if (r.error) die(`autoclean schedule: ${r.error}`);
    if (r.scheduler === 'none') die('no scheduler on this machine: neither a cron daemon nor /bin/sh');
    ok(`autoclean runs every 15 min via ${r.scheduler === 'cron' ? 'cron' : 'a background loop (no cron daemon on this machine)'}`);
    sub(`bundle ${BUNDLE} · repo ${primaryRoot()} · log ${AUTOCLEAN_LOG}`);
    for (const c of r.changed) sub(c);
    sub(`remove it: ${pc.cyan('pnpm worktree autoclean --uninstall-cron')}`);
    return;
  }
  if (a.flags.scheduled) {
    rotateLog();
    sh(['git', '-C', primaryRoot(), 'fetch', '--quiet', 'origin', 'dev']);
  }
  const dryRun = !!a.flags['dry-run'] || !a.flags.yes;
  if (a.flags.quiet) { await runAutoclean({ mode: 'auto', dryRun, stamp: !!a.flags.scheduled }); return; }
  await runAutoclean({ mode: 'explicit', dryRun });
  if (dryRun) sub(`pass ${pc.cyan('--yes')} to act`);
}

/** `start`: an over-cap apps/web/.next goes before `next dev` boots it (the first page compiles cold). */
function capNextBeforeStart(e: SlotEntry): void {
  const { config } = autocleanConfig(process.env);
  if (!config.enabled) return;
  const next = joinPath(e.path, 'apps/web/.next');
  if (!existsSync(next)) return;
  const live = listenPorts();
  if (live && (live.has(e.ports.web) || live.has(e.ports.api))) return;
  const kb = duKb(next);
  if (kb * 1024 <= config.capBytes) return;
  // Never under a process that works in apps/web (a `next build`), never while it is being written.
  if (recentWrite(next, RECENT_WRITE_MIN) || sweepBusy(joinPath(e.path, 'apps/web'), cwdTable().map((r) => r.cwd), psTable().map((r) => r.command))) return;
  rmSync(next, { recursive: true, force: true });
  sub(`deleted apps/web/.next (${gbOf(kb)} > cap ${gbs(config.capBytes)}) — the first page compiles cold · KORTIX_WORKTREE_NEXT_CAP_GB sets the cap`);
}

async function cmdDoctor(a: Args) {
  step('Toolchain');
  await ensureDeps({ database: true, isolatedDatabase: true, tunnel: true, install: !!a.flags.yes });
  step('Worktree integrity');
  const reg = loadRegistry();
  const root = repoRoot();
  const wts = sh(['git', '-C', root, 'worktree', 'list', '--porcelain']).stdout;
  for (const [n, e] of Object.entries(reg.slots)) {
    const issues: string[] = [];
    if (!existsSync(e.path)) issues.push('worktree dir missing');
    else if (!wts.includes(`worktree ${e.path}`)) issues.push('not a registered git worktree');
    const dbMode = dbModeOf(e);
    const orphan = dbMode === 'isolated'
      ? sh(['bash', '-lc', `docker ps -aq --filter "name=_${e.projectId}$" | head -1`]).stdout.trim()
      : '';
    console.log(`  ${issues.length ? pc.red('✗') : pc.green('✓')} ${n} ${pc.dim('(' + dbMode + ')')}${issues.length ? ' ' + pc.red(issues.join('; ')) : ''}${orphan ? pc.dim(' (containers present)') : ''}`);
  }
  // Allocators before pickSlot could hand one slot to several worktrees. They
  // share every port, and `start` on one kills the other's servers.
  const owners = new Map<number, string[]>();
  for (const [n, e] of Object.entries(reg.slots)) owners.set(e.slot, [...(owners.get(e.slot) ?? []), n]);
  for (const [slot, names] of owners) {
    if (names.length > 1) console.log(`  ${pc.red('✗')} slot ${slot} is shared by ${names.join(', ')} ${pc.red('— nuke and recreate all but one')}`);
  }

  // Memory pressure is the failure mode that actually bites here, and the registry
  // cannot be trusted to report it: a stack whose supervisor was OOM-killed stays
  // recorded however it was last written while its processes run on forever. Count
  // what is actually alive.
  step('Stack processes');
  const rows = psTable();
  const cwds = cwdTable();
  const drift: string[] = [];
  let live = 0;
  for (const [n, e] of Object.entries(reg.slots)) {
    const pids = stackPids(e.path, e.ports.api, { rows, cwds });
    if (!pids.length) {
      if (e.status === 'running') drift.push(`${n}: recorded running, nothing alive`);
      continue;
    }
    live += pids.length;
    if (e.status !== 'running') drift.push(`${n}: recorded ${e.status}, ${plural(pids.length, 'process', 'processes')} alive`);
    console.log(`  ${pc.yellow('●')} ${n} ${pc.dim(`${plural(pids.length, 'process', 'processes')} · recorded ${e.status}`)}`);
  }
  if (!live) ok('no worktree stacks running');
  else {
    warn(`${plural(live, 'process', 'processes')} held by worktree stacks`);
    sub(`free them all with ${pc.cyan('pnpm worktree stop --all')}`);
  }
  for (const d of drift) sub(pc.yellow('drift: ') + d);

  console.log(`\n  ${pc.dim('registry: ' + REGISTRY_PATH)}`);
}

function repoSlug(path: string, remote = 'origin'): string | null {
  const u = sh(['git', '-C', path, 'remote', 'get-url', remote]).stdout.trim();
  return u.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
}

async function cmdPr(a: Args) {
  const name = need(a.name);
  const reg = loadRegistry();
  const e = reg.slots[name];
  if (!e) die(`unknown worktree "${name}" — create it first`);
  if (!existsSync(e.path)) die(`worktree dir missing (${e.path})`);
  const { path, branch } = e;
  const base = (typeof a.flags.base === 'string' && a.flags.base) || 'dev';

  const ahead = sh(['git', '-C', path, 'rev-list', '--count', `${base}..${branch}`]).stdout.trim();
  if (!ahead || ahead === '0') die(`"${branch}" has no commits ahead of ${base} — commit something first`);
  if (sh(['git', '-C', path, 'status', '--porcelain']).stdout.trim())
    warn(`uncommitted changes in "${name}" won't be in the PR — commit them first if you want them included`);

  step(`Pushing ${pc.bold(branch)} → origin ${pc.dim(`(${ahead} commit${ahead === '1' ? '' : 's'} ahead of ${base})`)}`);
  if (await run(['git', '-C', path, 'push', '-u', 'origin', branch]) !== 0)
    die('git push failed — check your remote auth and retry');

  if (!which('gh')) {
    const slug = repoSlug(path);
    warn('gh CLI not found — branch pushed. Open the PR here:');
    sub(slug ? url(`https://github.com/${slug}/compare/${base}...${branch}?expand=1`) : `compare ${base}...${branch} on GitHub`);
    sub(`or install it (${pc.cyan('brew install gh')}) and re-run ${pc.cyan('pnpm worktree pr ' + name)}`);
    return;
  }

  step('Opening pull request');
  const gh = ['gh', 'pr', 'create', '--head', branch, '--base', base];
  if (typeof a.flags.repo === 'string') gh.push('--repo', a.flags.repo);
  if (typeof a.flags.title === 'string') gh.push('--title', a.flags.title, '--body', typeof a.flags.body === 'string' ? a.flags.body : '');
  else gh.push('--fill');
  if (a.flags.draft) gh.push('--draft');
  if (a.flags.web) gh.push('--web');
  if (await run(gh, { cwd: path }) !== 0)
    die(`gh pr create failed — a PR may already exist, or the base repo needs selecting. Retry with ${pc.cyan('pnpm worktree pr ' + name + ' --web')}`);
  ok(`PR opened for ${pc.bold(branch)}.`);
}

let a = parseArgs(process.argv.slice(2));
// The scheduled run names its repo explicitly: cron and the loop start outside any checkout.
if (a.cmd === 'autoclean') {
  const repo = typeof a.flags.repo === 'string' ? a.flags.repo : process.env.KORTIX_WORKTREE_REPO;
  if (repo) { try { process.chdir(repo); } catch { console.error(`✗ --repo ${repo}: no such directory`); process.exit(1); } }
}
const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
try {
  if (tty && a.cmd === 'help' && !a.flags.help && process.argv.length <= 2) {
    clack.intro(pc.bgCyan(pc.black(' pnpm worktree ')));
    const r = await menu();
    if (!r) process.exit(0);
    a = r;
  } else if (tty && (a.cmd === 'create' || a.cmd === 'new') && !a.name) {
    clack.intro(pc.bgCyan(pc.black(' pnpm worktree · create ')));
    const r = await promptCreate();
    if (!r) process.exit(0);
    a = r;
  } else if (tty && (a.cmd === 'nuke' || a.cmd === 'rm') && !a.names.length && !a.flags.all) {
    clack.intro(pc.bgCyan(pc.black(` pnpm worktree · ${a.cmd} `)));
    const names = await pickWorktrees(a.cmd);
    if (!names || !names.length) process.exit(0);
    a.names = names;
    a.name = names[0];
  } else if (tty && ['start', 'stop', 'status', 'pr'].includes(a.cmd) && !a.name) {
    clack.intro(pc.bgCyan(pc.black(` pnpm worktree · ${a.cmd} `)));
    const n = await pickWorktree(a.cmd);
    if (!n) process.exit(0);
    a.name = n;
    a.names = [n];
    if (a.cmd === 'start' && !a.flags.stripe && await confirmStripe()) a.flags.stripe = true;
  }

  switch (a.cmd) {
    case 'create': case 'new': await cmdCreate(a); break;
    case 'start': await cmdStart(a); break;
    case 'web': await cmdWeb(a); break;
    case 'stop': await cmdStop(a); break;
    case 'nuke': case 'rm': await cmdNuke(a); break;
    case 'list': case 'ls': cmdList(a); break;
    case 'status': cmdStatus(a); break;
    case 'pr': await cmdPr(a); break;
    case 'doctor': await cmdDoctor(a); break;
    case 'sweep': cmdSweep(a); break;
    case 'autoclean': await cmdAutoclean(a); break;
    case 'bundle-check': console.log('bundle-check ok'); break;
    default: usage();
  }
} catch (e: any) {
  console.error(`\n${pc.red('✗')} ${e?.message ?? e}`);
  process.exit(1);
}
