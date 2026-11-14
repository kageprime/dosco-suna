import { emitJson, fail, missing, type resolveAccountContext } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, pad, status } from '../style.ts';

// `kortix tokens service-accounts` — service accounts, the non-interactive
// credential that acts as THEMSELVES (`/accounts/:id/iam/…`). The engine
// evaluates a service-account request purely against the SA's own role
// assignments, so it never inherits the minter's access.
//
// A service account starts with NO permissions. Give it one with
// `kortix access grant --service-account <id> --role <key>`.

interface ServiceAccount {
  service_account_id: string;
  name: string;
  description: string | null;
  public_prefix: string;
  status?: string;
  secret?: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  disabled_at?: string | null;
}

export async function serviceAccounts(
  client: NonNullable<ReturnType<typeof resolveAccountContext>>['client'],
  base: string,
  positional: string[],
  opts: { json: boolean; yes: boolean; expiresAt?: string; description?: string },
): Promise<number> {
  const verb = positional[0];
  const id = positional[1];
  switch (verb) {
    case undefined:
    case 'ls':
    case 'list': {
      const { service_accounts: rows } = await client.get<{ service_accounts: ServiceAccount[] }>(
        base,
      );
      if (opts.json) {
        // The same shared `id` as `tokens ls --json`; `service_account_id` stays.
        emitJson(rows.map((r) => ({ id: r.service_account_id, ...r })));
        return 0;
      }
      if (rows.length === 0) {
        process.stdout.write(
          `\n  ${C.dim}No service accounts. Create one with ` +
            `${C.reset}${C.cyan}kortix tokens service-accounts new <name>${C.reset}\n\n`,
        );
        return 0;
      }
      const nameW = Math.max(...rows.map((r) => r.name.length), 4);
      const prefixW = Math.max(...rows.map((r) => r.public_prefix.length), 6);
      process.stdout.write('\n');
      process.stdout.write(
        `  ${C.dim}${pad('NAME', nameW)}   ${pad('PREFIX', prefixW)}   ${pad('STATUS', 8)}   ${pad('EXPIRES', 10)}   SERVICE ACCOUNT ID${C.reset}\n`,
      );
      for (const r of rows) {
        const state =
          r.status === 'active' ? (r.status ?? '—') : `${C.yellow}${r.status ?? '—'}${C.reset}`;
        process.stdout.write(
          `  ${pad(r.name, nameW)}   ${pad(r.public_prefix, prefixW)}   ${pad(state, 8)}   ` +
            `${pad(r.expires_at ? r.expires_at.slice(0, 10) : 'never', 10)}   ${C.faded}${r.service_account_id}${C.reset}\n`,
        );
      }
      process.stdout.write(
        `\n  ${C.dim}${rows.length} service account${rows.length === 1 ? '' : 's'}${C.reset}\n\n`,
      );
      return 0;
    }

    case 'new':
    case 'create': {
      const name = positional[1];
      if (!name) return missing('a service account name');
      const created = await client.post<ServiceAccount>(base, {
        name,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
      });
      if (opts.json) {
        emitJson(created);
        return 0;
      }
      process.stdout.write(
        `${status.ok(`Created service account ${C.bold}${created.name}${C.reset}`)}\n\n`,
      );
      process.stdout.write(`  ${created.secret ?? '(no secret returned)'}\n\n`);
      process.stdout.write(
        `${status.warn('This is the only time the bearer is shown. Store it now.')}\n`,
      );
      process.stdout.write(`  ${C.dim}id      ${C.reset}${created.service_account_id}\n`);
      process.stdout.write(
        `  ${C.dim}expires ${C.reset}${created.expires_at ? created.expires_at.slice(0, 10) : 'never'}\n\n`,
      );
      process.stdout.write(
        `  ${C.dim}It holds no permissions yet. Grant one with${C.reset}\n` +
          `  ${C.cyan}kortix access grant --service-account ${created.service_account_id} --role <key>${C.reset}\n`,
      );
      return 0;
    }

    case 'disable': {
      if (!id) return missing('a service account id');
      await client.post(`${base}/${encodeURIComponent(id)}/disable`, {});
      process.stdout.write(`${status.ok(`Disabled ${C.bold}${id}${C.reset}`)}\n`);
      return 0;
    }

    case 'rm':
    case 'delete': {
      if (!id) return missing('a service account id');
      if (!opts.yes) {
        const ok = await confirm(
          `Delete service account ${C.bold}${id}${C.reset}? Its bearer stops working immediately.`,
          false,
          { onEndOfInput: false },
        );
        if (!ok) {
          process.stdout.write(`${C.dim}Cancelled.${C.reset}\n`);
          return 0;
        }
      }
      await client.delete(`${base}/${encodeURIComponent(id)}`);
      process.stdout.write(`${status.ok(`Deleted ${C.bold}${id}${C.reset}`)}\n`);
      return 0;
    }

    default:
      return fail(`unknown service-accounts verb "${verb}" — use ls|new|disable|rm`);
  }
}
