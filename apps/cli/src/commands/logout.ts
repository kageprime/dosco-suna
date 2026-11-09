import { authFileLocation, clearAuth, loadAuthForHost } from '../api/auth.ts';
import { activeHostName, getHost } from '../api/config.ts';
import { ApiError, clientFromAuth } from '../api/client.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix logout [options]

Remove the Kortix auth token for one host.

Shortcut for the active host — same as \`kortix hosts logout\`. Use
\`kortix hosts logout <name>\` to sign out of a different instance.

Options:
  --host <name>     Log out of a specific named host (default: active).
  -h, --help        Show this help.
`;

export async function runLogout(argv: string[]): Promise<number> {
  const flags = takeFlags(argv, HELP, (rest) => ({ host: takeFlagValue(rest, ['--host']) }));
  if (typeof flags === 'number') return flags;
  return performLogout(flags.host);
}

/**
 * Shared logout implementation used by both the top-level `kortix logout`
 * alias and the `kortix hosts logout` subcommand. Revokes the stored token
 * on the API (best effort), then clears it for the named host, defaulting
 * to the active host when omitted.
 */
export async function performLogout(hostName?: string): Promise<number> {
  const target = hostName ?? activeHostName();
  if (!target) {
    process.stdout.write(`${C.dim}Not logged in. Nothing to do.${C.reset}\n`);
    return 0;
  }
  const before = getHost(target);
  const auth = loadAuthForHost(target);
  if (!auth?.token) {
    process.stdout.write(`${C.dim}Host "${target}" already logged out.${C.reset}\n`);
    return 0;
  }
  // Revoke the credential server-side BEFORE clearing (KRTX-4493): clearing
  // the config alone left the login key active, so a logged-out PAT kept
  // answering and every login/logout cycle left one more live key under
  // Settings → Personal keys. The CLI holds only the secret PAT — the lists
  // expose `public_key` — so it cannot map its bearer to a token_id: the API
  // revokes the presented credential. A failed revocation still clears the
  // local state; it is a warning, not a failed logout.
  let revokeError: string | null = null;
  try {
    await clientFromAuth(auth).delete('/me/tokens/self');
  } catch (error) {
    revokeError = error instanceof ApiError && error.status
      ? `the API answered ${error.status}`
      : error instanceof Error ? error.message : String(error);
  }
  clearAuth(target);
  process.stdout.write(
    `${status.ok(`Logged out of ${C.bold}${target}${C.reset}${C.dim} (was ${before?.user_email || before?.user_id || 'anonymous'})${C.reset}`)}\n`,
  );
  if (revokeError) {
    process.stdout.write(
      `${status.warn(`The login key could not be revoked (${revokeError}). Revoke it in Settings → Personal keys.`)}\n`,
    );
  }
  process.stdout.write(`${C.dim}  Config: ${authFileLocation()}${C.reset}\n`);
  return 0;
}
