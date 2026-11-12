/**
 * The local part of a Kortix-managed inbox (`<local>@<managed domain>`).
 *
 * Dev, staging and prod share one Resend team, so the managed domain is one
 * namespace for every environment: an address a dev workspace takes is gone
 * for prod. Two rules keep the environments apart:
 *
 *   1. Generic and Kortix-owned names (`hello`, `support`, `postmaster`, …)
 *      are reserved in every environment. A dev test workspace once took
 *      `hello@` on the managed domain.
 *   2. Outside prod, the address ends in `.<env>` (`orders.dev@`), so a
 *      non-prod inbox never takes a name a prod customer wants.
 *
 * A workspace's own Resend key is its own namespace: these rules apply to the
 * managed domain only.
 */

export type KortixEnv = 'dev' | 'staging' | 'prod' | 'preview';

/** The longest local part Kortix creates (`normalizeEmailUsername`). */
const LOCAL_PART_MAX = 48;

export const RESERVED_MANAGED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'abuse', 'account', 'accounts', 'admin', 'administrator', 'api', 'billing', 'careers', 'compliance',
  'contact', 'dev', 'devops', 'dmarc', 'email', 'feedback', 'finance', 'founders', 'hello', 'help',
  'hostmaster', 'hr', 'info', 'jobs', 'kortix', 'legal', 'mail', 'mailer-daemon', 'marketing', 'news',
  'newsletter', 'no-reply', 'noreply', 'office', 'ops', 'postmaster', 'press', 'privacy', 'prod', 'root',
  'sales', 'security', 'staging', 'support', 'sysadmin', 'team', 'test', 'webmaster', 'www',
]);

/** What a managed address ends in before the @: `.dev`, `.staging`, `.preview`; '' in prod. */
export function managedInboxSuffix(env: KortixEnv): string {
  return env === 'prod' ? '' : `.${env}`;
}

/** The local part to create, or why the name cannot be used on the managed domain. */
export function managedInboxLocalPart(
  username: string,
  env: KortixEnv,
): { localPart: string } | { error: string } {
  const suffix = managedInboxSuffix(env);
  // A typed environment suffix is dropped and added back for this one:
  // `hello.dev` is `hello`, and a prod name never claims `.dev`.
  const base = username.toLowerCase().replace(/\.(?:dev|staging|preview|prod)$/, '');
  if (RESERVED_MANAGED_LOCAL_PARTS.has(base)) {
    return { error: `"${base}" is reserved on the Kortix email domain. Pick another name before the @.` };
  }
  const head = base.slice(0, LOCAL_PART_MAX - suffix.length).replace(/[-.]+$/g, '');
  if (!head) return { error: 'Enter a name before the @' };
  return { localPart: `${head}${suffix}` };
}
