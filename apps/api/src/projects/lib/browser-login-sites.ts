/**
 * Pure rules for website logins (see `./browser-logins.ts`): which sites a
 * login may be filled on, and the stored value's shape. No database, no I/O,
 * so the permission decision is testable on its own.
 */
import type { SecretEgressPolicy } from '../../secrets/strategy';

/** At most this many sites per login. Sign-in flows that span more hosts are
 *  rare, and every extra host widens where the password may be typed. */
export const BROWSER_LOGIN_MAX_SITES = 10;
const MAX_USERNAME_CHARS = 512;
const MAX_PASSWORD_CHARS = 4096;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What a login secret stores, encrypted like every project secret. */
export interface BrowserLoginValue {
  username: string;
  password: string;
}

/**
 * One site as the host a login may be typed on: `app.example.com`. Accepts a
 * bare host or a URL (`https://app.example.com/login` → `app.example.com`).
 * Exact hosts only: no wildcard, no IPv6 literal. A port is dropped: a login is
 * matched by host (`loginSiteAdmits`), as a browser scopes cookies. `localhost`
 * and an IPv4 address are accepted so a login can be tested against a local page.
 * Null when the input names no usable host.
 */
export function normalizeLoginSite(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (!text || text.includes('*') || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, '');
  if (!host || host.length > 253 || host.startsWith('[')) return null;
  if (!host.split('.').every((label) => HOST_LABEL.test(label))) return null;
  return host;
}

/** Normalize and de-duplicate a site list; every entry must be usable. */
export function normalizeLoginSites(
  raw: unknown,
): { ok: true; sites: string[] } | { ok: false; error: string } {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0) {
    return { ok: false, error: 'sites is required: the hosts this login may be typed on, e.g. ["app.example.com"]' };
  }
  const sites: string[] = [];
  for (const entry of list) {
    const site = normalizeLoginSite(entry);
    if (!site) {
      return {
        ok: false,
        error: `"${String(entry)}" is not a site. Pass a host such as app.example.com (no wildcard).`,
      };
    }
    if (!sites.includes(site)) sites.push(site);
  }
  if (sites.length > BROWSER_LOGIN_MAX_SITES) {
    return { ok: false, error: `A login may name at most ${BROWSER_LOGIN_MAX_SITES} sites.` };
  }
  return { ok: true, sites };
}

/** The stored policy for a login: one rule per site, host only. */
export function loginPolicyFor(sites: readonly string[]): SecretEgressPolicy {
  return { rules: sites.map((host) => ({ host })) };
}

/** The sites a stored login policy names. Malformed rules are dropped. */
export function loginSitesOf(policy: SecretEgressPolicy | null | undefined): string[] {
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  const sites: string[] = [];
  for (const rule of rules) {
    const site = normalizeLoginSite(rule?.host);
    if (site && !sites.includes(site)) sites.push(site);
  }
  return sites;
}

/** The host of an http(s) URL, or null. */
export function loginUrlHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * May this login be typed on `url`? Its host must equal one of the sites
 * exactly: `example.com` does not admit `www.example.com`, and a lookalike
 * such as `example.com.evil.test` never matches.
 */
export function loginSiteAdmits(sites: readonly string[], url: string): boolean {
  const host = loginUrlHost(url);
  return host !== null && sites.includes(host);
}

export function encodeBrowserLogin(login: BrowserLoginValue): string {
  return JSON.stringify({ username: login.username, password: login.password });
}

/** The stored value as a login, or null when it is not one (a damaged row). */
export function decodeBrowserLogin(value: string): BrowserLoginValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { username, password } = parsed as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!username || !password) return null;
  return { username, password };
}

/** A submitted `{ username, password }`, checked. Values are kept verbatim. */
export function parseBrowserLoginInput(
  raw: unknown,
): { ok: true; login: BrowserLoginValue } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Enter a username and a password.' };
  const { username, password } = raw as Record<string, unknown>;
  if (typeof username !== 'string' || !username.trim()) return { ok: false, error: 'Enter a username.' };
  if (typeof password !== 'string' || !password) return { ok: false, error: 'Enter a password.' };
  if (username.length > MAX_USERNAME_CHARS) return { ok: false, error: 'The username is too long.' };
  if (password.length > MAX_PASSWORD_CHARS) return { ok: false, error: 'The password is too long.' };
  return { ok: true, login: { username: username.trim(), password } };
}
