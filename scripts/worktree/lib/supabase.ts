import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Ports } from './ports';
import { portInUse, run, sh, type ShResult } from './exec';
import { supaWorkdir, WT_HOME } from './registry';
import { supabaseBin } from './supabase-cli';

export const SHARED_SUPABASE_PORTS = {
  sbApi: 54321,
  sbDb: 54322,
  sbStudio: 54323,
  sbInbucket: 54324,
} as const;

export function rewriteConfigToml(toml: string, projectId: string, ports: Ports): string {
  const sectionPort: Record<string, number> = {
    '[api]': ports.sbApi, '[db]': ports.sbDb, '[db.pooler]': ports.sbPooler,
    '[studio]': ports.sbStudio, '[inbucket]': ports.sbInbucket, '[analytics]': ports.sbAnalytics,
  };
  const lines = toml.split('\n');
  let section = '';
  const out = lines.map((line) => {
    const secMatch = line.match(/^\s*(\[[^\]]+\])\s*$/);
    if (secMatch) { section = secMatch[1]; return line; }
    if (/^\s*project_id\s*=/.test(line)) return `project_id = "${projectId}"`;
    if (/^\s*port\s*=/.test(line) && section in sectionPort) {
      return line.replace(/port\s*=\s*\d+/, `port = ${sectionPort[section]}`);
    }
    return line.replace(/127\.0\.0\.1:54321/g, `127.0.0.1:${ports.sbApi}`)
               .replace(/localhost:54321/g, `localhost:${ports.sbApi}`)
               .replace(/127\.0\.0\.1:3000/g, `127.0.0.1:${ports.web}`)
               .replace(/localhost:3000/g, `localhost:${ports.web}`);
  });
  return out.join('\n');
}

export function renderSupabaseProject(name: string, worktreePath: string, projectId: string, ports: Ports) {
  const wd = supaWorkdir(name);
  const sbDir = join(wd, 'supabase');
  mkdirSync(sbDir, { recursive: true });

  const srcToml = readFileSync(join(worktreePath, 'supabase', 'config.toml'), 'utf8');
  const rewritten = rewriteConfigToml(srcToml, projectId, ports);
  writeFileSync(join(sbDir, 'config.toml'), rewritten);

  for (const sub of ['seed.sql', 'functions', 'templates']) {
    const target = join(worktreePath, 'supabase', sub);
    const link = join(sbDir, sub);
    if (existsSync(target) && !existsSync(link)) {
      try { symlinkSync(target, link); } catch {}
    }
  }
  return wd;
}

export async function startSupabaseDb(name: string): Promise<number> {
  return run([supabaseBin(), '--workdir', supaWorkdir(name), 'db', 'start']);
}

export async function startSupabaseFullStack(name: string, ports: Ports): Promise<number> {
  if (!portInUse(ports.sbApi).inUse) {
    await run([supabaseBin(), '--workdir', supaWorkdir(name), 'stop']);
  }
  return run([supabaseBin(), '--workdir', supaWorkdir(name), 'start', '-x', 'postgrest']);
}

export function slotDbUrl(ports: Pick<Ports, 'sbDb'>): string {
  return `postgresql://postgres:postgres@127.0.0.1:${ports.sbDb}/postgres`;
}

export function hasKortixSchema(db: string | Pick<Ports, 'sbDb'>): boolean {
  const sql = "select 1 from information_schema.tables where table_schema='kortix' limit 1";
  return sh(['psql', typeof db === 'string' ? db : slotDbUrl(db), '-XtAc', sql]).stdout.trim() === '1';
}

export function supa(name: string, args: string[], opts: { stream?: boolean } = {}): ShResult | Promise<number> {
  const cmd = [supabaseBin(), '--workdir', supaWorkdir(name), ...args];
  return opts.stream ? run(cmd) : sh(cmd);
}

export function supaStatusEnv(name: string): Record<string, string> {
  const r = sh([supabaseBin(), '--workdir', supaWorkdir(name), 'status', '-o', 'env']);
  if (!r.ok) return {};
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export interface SlotCreds {
  dbUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
  jwtSecret: string;
  /** Supabase Storage's S3 protocol key pair — the API's object store signs
   *  config archive requests with it. `supabase status` prints both. */
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

export function slotCredsFromStatus(ports: Ports, st: Record<string, string>): SlotCreds {
  return {
    dbUrl: st.DB_URL || `postgresql://postgres:postgres@127.0.0.1:${ports.sbDb}/postgres`,
    supabaseUrl: st.API_URL || `http://127.0.0.1:${ports.sbApi}`,
    serviceRoleKey: st.SERVICE_ROLE_KEY || '',
    anonKey: st.ANON_KEY || '',
    jwtSecret: st.JWT_SECRET || '',
    s3AccessKeyId: st.S3_PROTOCOL_ACCESS_KEY_ID || '',
    s3SecretAccessKey: st.S3_PROTOCOL_ACCESS_KEY_SECRET || '',
  };
}

export function primarySupabaseStatusEnv(root: string): Record<string, string> {
  const r = sh([supabaseBin(), 'status', '-o', 'env'], { cwd: root });
  if (!r.ok) return {};
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** The pid of a primary Supabase start that `worktree create` left running (prewarmPrimarySupabase), and its log. */
const PREWARM_PID = join(WT_HOME, 'primary-supabase-prewarm.pid');
export const PREWARM_LOG = join(WT_HOME, 'primary-supabase-prewarm.log');

/** The prewarm's pid while that process is alive, else null (and a stale pid file is removed). */
export function prewarmRunning(pidFile = PREWARM_PID): number | null {
  let pid: number;
  try { pid = Number(readFileSync(pidFile, 'utf8').trim()); } catch { return null; }
  try {
    if (pid > 0) { process.kill(pid, 0); return pid; }
  } catch { /* gone */ }
  rmSync(pidFile, { force: true });
  return null;
}

/**
 * Bring the primary checkout's Supabase up in a detached child, the way ensurePrimarySupabase does (`stop`, then
 * `start -x postgrest`), so it starts while `worktree create` checks out and installs instead of inside
 * `worktree start`. Measured on a 6 vCPU Kortix session (2026-11-26), fresh Supabase each time: `create` to a live
 * API took 82.2 / 83.1 s in sequence and 55.3 / 58.8 s with this; Supabase was up at +26.7 s, before `create` ended.
 * Starts nothing, and returns false, when the stack already answers, a prewarm is running, or Docker is not.
 */
export function prewarmPrimarySupabase(root: string, pidFile = PREWARM_PID, logFile = PREWARM_LOG): boolean {
  if (prewarmRunning(pidFile)) return false;
  const env = primarySupabaseStatusEnv(root);
  if (env.API_URL && env.DB_URL && env.SERVICE_ROLE_KEY && env.ANON_KEY) return false;
  if (!sh(['docker', 'info']).ok) return false;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    mkdirSync(WT_HOME, { recursive: true });
    const log = openSync(logFile, 'w');
    const child = spawnChild('bash', ['-c', `${q(supabaseBin())} stop; exec ${q(supabaseBin())} start -x postgrest`], {
      cwd: root, detached: true, stdio: ['ignore', log, log],
    });
    child.on('error', () => {});
    if (!child.pid) return false;
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    return true;
  } catch {
    return false; // `worktree start` starts it itself.
  }
}

/**
 * Wait, up to `maxMs`, for a prewarm that is still running. ensurePrimarySupabase stops a half-up stack before it
 * starts one, which would kill a start in flight. Returns true when it waited.
 */
export async function waitForPrimaryPrewarm(maxMs = 240_000, pidFile = PREWARM_PID): Promise<boolean> {
  if (!prewarmRunning(pidFile)) return false;
  const deadline = Date.now() + maxMs;
  while (prewarmRunning(pidFile) && Date.now() < deadline) await Bun.sleep(500);
  return true;
}

export async function ensurePrimarySupabase(root: string): Promise<Record<string, string>> {
  if (await waitForPrimaryPrewarm()) console.log('  waited for the Supabase start that `worktree create` began');
  let env = primarySupabaseStatusEnv(root);
  if (env.API_URL && env.DB_URL && env.SERVICE_ROLE_KEY && env.ANON_KEY) return env;
  // Status came back incomplete, so the primary stack is down or half-up. Clear
  // it before starting: `supabase start` only checks that the containers EXIST,
  // not that they are healthy, so against containers SIGKILLed by Docker Desktop
  // quitting (or the Mac sleeping) it reports "already running" and then dies on
  // "container is not running: exited". Unconditional — unlike
  // startSupabaseFullStack's port probe — because a half-up stack still holds
  // the API port while the db container is dead, and that is the case a port
  // probe would wave through into the same failure.
  //
  // NEVER add --no-backup: it deletes the data volumes, i.e. the primary
  // checkout's local Postgres that every shared-db worktree runs against.
  await run([supabaseBin(), 'stop'], { cwd: root });
  const started = await run([supabaseBin(), 'start', '-x', 'postgrest'], { cwd: root });
  if (started !== 0) return {};
  env = primarySupabaseStatusEnv(root);
  return env;
}

export function primaryCredsFromStatus(st: Record<string, string>): SlotCreds {
  return {
    dbUrl: st.DB_URL || `postgresql://postgres:postgres@127.0.0.1:${SHARED_SUPABASE_PORTS.sbDb}/postgres`,
    supabaseUrl: st.API_URL || `http://127.0.0.1:${SHARED_SUPABASE_PORTS.sbApi}`,
    serviceRoleKey: st.SERVICE_ROLE_KEY || '',
    anonKey: st.ANON_KEY || '',
    jwtSecret: st.JWT_SECRET || '',
    s3AccessKeyId: st.S3_PROTOCOL_ACCESS_KEY_ID || '',
    s3SecretAccessKey: st.S3_PROTOCOL_ACCESS_KEY_SECRET || '',
  };
}
