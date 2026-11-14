import { emitJson, fail, missing, type resolveAccountContext } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, pad, status, visibleWidth } from '../style.ts';

// `kortix tokens apps` — connected OAuth apps: the grants you approved with
// "Sign in with Kortix", routed here by the `kortix tokens` dispatcher.

/** One row of `GET /oauth/grants`. */
interface ConnectedApp {
  client_id: string;
  name: string;
  self_registered: boolean;
  redirect_hosts: string[];
  granted_at: string | null;
  last_active_at: string | null;
}

/** `kortix tokens apps` — OAuth grants you approved ("Sign in with Kortix"). */
export async function connectedApps(
  client: NonNullable<ReturnType<typeof resolveAccountContext>>['client'],
  positional: string[],
  opts: { json: boolean; yes: boolean },
): Promise<number> {
  const action = positional[0] ?? 'ls';
  if (action === 'ls' || action === 'list') {
    const { grants } = await client.get<{ grants: ConnectedApp[] }>('/oauth/grants');
    if (opts.json) {
      emitJson(grants);
      return 0;
    }
    if (grants.length === 0) {
      process.stdout.write(`\n  ${C.dim}No connected apps.${C.reset}\n\n`);
      return 0;
    }
    const label = (g: ConnectedApp) =>
      g.self_registered ? `${g.name} ${C.yellow}(unverified)${C.reset}` : g.name;
    const nameW = Math.max(...grants.map((g) => visibleWidth(label(g))), 4);
    process.stdout.write('\n');
    process.stdout.write(
      `  ${C.dim}${pad('NAME', nameW)}   ${pad('SIGNS IN AT', 22)}   ${pad('LAST ACTIVE', 11)}   CLIENT ID${C.reset}\n`,
    );
    for (const g of grants) {
      process.stdout.write(
        `  ${pad(label(g), nameW)}   ${pad(g.redirect_hosts.join(', ') || '-', 22)}   ` +
          `${pad((g.last_active_at ?? g.granted_at ?? '-').slice(0, 10), 11)}   ${C.faded}${g.client_id}${C.reset}\n`,
      );
    }
    process.stdout.write(
      `\n  ${C.dim}${grants.length} app${grants.length === 1 ? '' : 's'}${C.reset}\n\n`,
    );
    return 0;
  }
  if (action === 'rm' || action === 'revoke') {
    const clientId = positional[1];
    if (!clientId) return missing('a client id (see `kortix tokens apps ls`)');
    if (!opts.yes) {
      const ok = await confirm(
        `Revoke ${C.bold}${clientId}${C.reset}? It loses access to your account at once.`,
        false,
        { onEndOfInput: false },
      );
      if (!ok) {
        process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
        return 0;
      }
    }
    const r = await client.delete<{ revoked_tokens: number }>(
      `/oauth/grants/${encodeURIComponent(clientId)}`,
    );
    if (opts.json) {
      emitJson(r);
      return 0;
    }
    process.stdout.write(
      `${status.ok(`Revoked ${C.bold}${clientId}${C.reset} (${r.revoked_tokens} live token${r.revoked_tokens === 1 ? '' : 's'})`)}\n`,
    );
    return 0;
  }
  return fail(`Unknown \`tokens apps\` action "${action}". Use ls or rm.`);
}
