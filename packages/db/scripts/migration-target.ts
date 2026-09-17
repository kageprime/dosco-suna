export function migrationCheckOrder(command: string, databaseUrl: string): boolean {
  if (command !== 'local-up') return true;

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('local-up requires a valid loopback DATABASE_URL');
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(`local-up refuses non-loopback database host: ${hostname}`);
  }
  return false;
}

export function migrationBootstrapsPrerequisites(command: string): boolean {
  return command === 'bootstrap' || command === 'local-up';
}

/**
 * Hosts `bootstrap`/`local-up` may install fresh-DB prerequisites on: loopback
 * (dev/worktree databases) and the self-host Compose database service. The
 * updater's `kortix-migrate` one-shot always reaches Postgres as `supabase-db`
 * (see the `DATABASE_URL` in assets/kortix-compose.yml), so it must stay
 * allowed here or every self-host update breaks.
 *
 * Anything else (notably `*.pooler.supabase.com` / `db.*.supabase.co`) is a
 * provisioned or managed database: installing the basejump stub, welcome-email
 * trigger, and extension set there would corrupt a platform-owned auth/storage
 * installation. Refused unless the operator passes `--allow-remote`.
 */
const BOOTSTRAP_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
  'supabase-db',
]);

export function assertBootstrapTargetAllowed(
  command: string,
  databaseUrl: string,
  argv: readonly string[] = [],
): void {
  if (!migrationBootstrapsPrerequisites(command)) return;
  if (argv.includes('--allow-remote')) return;
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`${command} requires a valid DATABASE_URL`);
  }
  if (!BOOTSTRAP_ALLOWED_HOSTS.has(hostname.toLowerCase())) {
    throw new Error(
      `${command} refuses remote database host: ${hostname} — it installs fresh-DB ` +
        'prerequisites (basejump stub, welcome-email trigger, extensions) that must never run ' +
        'against a provisioned/managed database. Use `up` instead, or pass --allow-remote ' +
        'if you really mean it.',
    );
  }
}
