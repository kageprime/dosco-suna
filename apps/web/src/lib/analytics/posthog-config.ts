/**
 * PostHog rules that decide what leaves the browser. Pure functions, no
 * posthog-js import: `posthog-client.ts` applies them, the unit test pins them.
 *
 * 1. Where to send. A project key belongs to kortix.com (and loopmaxxing.sh,
 *    the developer landing it serves). Any other host —
 *    dev, staging, a self-hosted install, a white-label domain, a PR preview —
 *    gets no key,
 *    so posthog-js is never even downloaded there. Project keys are public by
 *    design (every visitor's browser receives them); they authorize writes
 *    only. Local runs opt in with NEXT_PUBLIC_POSTHOG_KEY.
 * 2. Consent. Storage needs the visitor's analytics consent from the CookieYes
 *    banner. Without it the client keeps its ids in memory only.
 * 3. What a URL may say. Signed-in and capability-token pages carry customer
 *    names and one-time tokens in the path, and auth pages carry the email in
 *    the query. Every URL is reduced before it is sent: own-origin paths under
 *    the app become a route template, only campaign parameters survive the
 *    query, and the hash never leaves.
 * 4. Session replay (decision 2026-11-19). A visitor is recorded unless they
 *    rejected analytics in the banner, within the free plan's 5,000
 *    recordings a month: every session of a person who signed up in the last
 *    14 days, a tenth of other signed-in sessions, a fiftieth of anonymous
 *    ones. For a signed-in person, and on every private or sign-in page, the
 *    recording hides every text and every attribute that can carry text,
 *    except our own interface text (`UiText`, `replay-text.ts`): a label,
 *    button or heading from the translation catalog stays readable, with
 *    numbers in its placeholders. Message and document text never shows
 *    (`REPLAY_CONTENT_SELECTOR`). Every input, link targets off our origin
 *    and image sources are hidden; frames are blocked. Page URLs follow
 *    rule 3. A click event on those pages keeps the same interface text.
 */

/** Our own interface text (`UiTextIndex` in `replay-text.ts`). */
export interface UiText {
  has(text: string): boolean;
}

import { locales } from '@/i18n/catalog.mjs';
import { analyticsLocation, isAnalyticsExcludedPath } from '@/lib/analytics/url-policy';

/** EU Cloud project 334925, which collects kortix.com. Public: a write-only client key. */
export const POSTHOG_PROJECT_KEY = 'phc_nPL2v9FLjKUyXvaabr4tdvCCRTCUw4nUt6GqsnAeTAHs';
export const POSTHOG_UI_HOST = 'https://eu.posthog.com';
/** Same-origin reverse proxy (next.config.ts rewrites to eu.i.posthog.com). */
export const POSTHOG_API_HOST = '/ingest';

export type AnalyticsEnvironment = 'production' | 'staging' | 'dev' | 'local';

/** Hosts that send to the Kortix project, with the environment they report. */
// Production only (decision 2026-11-06): the free plan has one project, and
// dev and staging traffic in it is noise. They report nothing.
const HOST_ENVIRONMENTS: Record<string, AnalyticsEnvironment> = {
  'kortix.com': 'production',
  'www.kortix.com': 'production',
  // The developer landing (Loopmaxxing) on its own domain: the setup prompt is copied there.
  'loopmaxxing.sh': 'production',
  'www.loopmaxxing.sh': 'production',
};

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/**
 * Hosts whose sessions may be recorded. loopmaxxing.sh is not one yet: its
 * CookieYes banner does not load there, so a visitor could not reject.
 */
const REPLAY_HOSTS = new Set(['kortix.com', 'www.kortix.com']);

export interface PostHogProject {
  key: string;
  environment: AnalyticsEnvironment;
  /** Session replay may run on this host (`shouldRecordSession`). */
  replay: boolean;
}

/**
 * The project this page reports to, or null when it must not report at all.
 * `localKey` is NEXT_PUBLIC_POSTHOG_KEY: it enables a local run and nothing
 * else, so a self-host image built with the variable still sends nothing.
 */
export function posthogProjectForHost(
  hostname: string,
  localKey: string | undefined,
): PostHogProject | null {
  const host = hostname.toLowerCase();
  const environment = HOST_ENVIRONMENTS[host];
  if (environment) return { key: POSTHOG_PROJECT_KEY, environment, replay: REPLAY_HOSTS.has(host) };
  if (isLocalHost(host) && localKey?.startsWith('phc_')) {
    return { key: localKey, environment: 'local', replay: true };
  }
  return null;
}

export type AnalyticsConsent = 'granted' | 'denied' | 'unknown';

/**
 * The analytics answer stored by the CookieYes banner (loaded through GTM on
 * marketing pages). Its cookie reads
 * `consentid:…,consent:yes,action:yes,necessary:yes,analytics:yes,…`;
 * `action:yes` means the visitor answered. A region where the banner grants
 * by default writes `analytics:yes` without an action, which is a grant.
 */
export function readAnalyticsConsent(cookieHeader: string): AnalyticsConsent {
  const raw = cookieHeader
    .split(/;\s*/)
    .find((part) => part.startsWith('cookieyes-consent='))
    ?.slice('cookieyes-consent='.length);
  if (!raw) return 'unknown';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return 'unknown';
  }
  const fields = new Map(
    decoded.split(',').map((pair) => {
      const index = pair.indexOf(':');
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] as const;
    }),
  );
  if (fields.get('analytics') === 'yes') return 'granted';
  if (fields.get('action') === 'yes') return 'denied';
  return 'unknown';
}

/** Signed-in and capability-token pages. Their paths and text are customer data. */
export function isPrivatePath(pathname: string): boolean {
  return isAnalyticsExcludedPath(pathname);
}

/**
 * Path segments a private route may keep. Every other segment is an id, a
 * slug, an agent or file name, or a token, and becomes `:id`.
 */
const ROUTE_WORDS = new Set([
  // Route folders under app/[locale]. `projects` is the pre-2026-11-06 name.
  'workspaces',
  'projects',
  'sessions',
  'customize',
  'agents',
  'admin',
  'connectors',
  'artifacts',
  'c',
  'dm',
  'goals',
  'spaces',
  'settings',
  'capture',
  'inbox',
  'panel',
  'redeem',
  'discord',
  'install',
  'devices',
  'invites',
  'slack',
  'teams',
  'login',
  'tunnel',
  'authorize',
  'connect',
  'secret-intake',
  'share',
  'artifact',
  'response',
  'session',
  'approve',
  'new',
  'setup',
  'cli',
  'oauth',
  'preview',
  'github',
  'connections',
  'start',
  'chat',
  'space',
  'drive',
  'calendar',
  'reminders',
  'checkout',
  'compare',
  'change-requests',
  'evals',
  'eval-datasets',
  'eval-jobs',
  'eval-tasks',
  // Fixed tab and section names.
  'billing',
  'plan',
  'profile',
  'members',
  'tokens',
  'api-keys',
  'webhooks',
  'schedules',
  'secrets',
  'computer',
  'computers',
  'general',
  'git',
  'triggers',
  'providers',
  'skills',
  'models',
  'review',
  'sandboxes',
  'accounts',
  'loops',
  'analytics',
  'usage',
  'security',
  'team',
  'integrations',
  'notifications',
  'appearance',
  'tools',
  'memory',
  'files',
  'apps',
  'channels',
  'shared',
]);

/** `/de/workspaces/9f…/sessions/4a…` → `/workspaces/:id/sessions/:id`. */
export function routeTemplate(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && (locales as readonly string[]).includes(segments[0]!)) {
    segments.shift();
  }
  const kept = segments.map((segment) => {
    const word = segment.toLowerCase();
    return ROUTE_WORDS.has(word) ? word : ':id';
  });
  return `/${kept.join('/')}`;
}

/**
 * The URL as PostHog may store it. Own-origin: origin, a path (a template on
 * private pages) and only campaign parameters. Another origin: origin and
 * path, nothing else. Not a URL: dropped.
 */
export function sanitizeUrl(value: string, origin: string): string | null {
  // PostHog's own markers such as `$direct` are not URLs and pass unchanged.
  if (!/^(https?:\/\/|\/)/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== origin) return `${url.origin}${url.pathname}`;
  const path = isPrivatePath(url.pathname) ? routeTemplate(url.pathname) : url.pathname;
  return analyticsLocation(url.origin, path, url.search);
}

/** A path as PostHog may store it. */
export function sanitizePath(pathname: string): string {
  return isPrivatePath(pathname) ? routeTemplate(pathname) : pathname;
}

/** `$current_url`, `$initial_current_url`, `$session_entry_url`, `$referrer`, … */
const URL_KEY = /(url|href|referrer)$/;
/** `$pathname`, `$initial_pathname`, `$prev_pageview_pathname`, … */
const PATH_KEY = /pathname$/;

/** Element-chain attributes that can carry customer text on a private page. */
const CHAIN_TEXT =
  /(\btext|\bhref|attr__(?:href|title|aria-label|alt|placeholder|value|name|data-[\w-]*))="((?:[^"\\]|\\.)*)"/g;
/** Chain attributes that may keep a value when it is our own interface text. */
const CHAIN_UI_TEXT = new Set([
  'text',
  'attr__title',
  'attr__aria-label',
  'attr__alt',
  'attr__placeholder',
]);

type Props = Record<string, unknown>;

function scrubBag(bag: Props | undefined, origin: string): void {
  if (!bag) return;
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value !== 'string') continue;
    const name = key.toLowerCase();
    if (URL_KEY.test(name)) {
      const clean = sanitizeUrl(value, origin);
      if (clean === null) delete bag[key];
      else bag[key] = clean;
    } else if (PATH_KEY.test(name)) {
      bag[key] = sanitizePath(value);
    }
  }
}

export interface ScrubbableEvent {
  event: string;
  properties: Props;
  $set?: Props;
  $set_once?: Props;
}

/**
 * The `before_send` hook. Rewrites every URL- and path-valued property, and on
 * private pages removes page titles, link targets and every piece of element
 * text an autocapture event carries, except our own interface text (`ui`).
 * Never drops an event.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T, origin: string, ui?: UiText): T {
  const pathname =
    typeof event.properties.$pathname === 'string'
      ? event.properties.$pathname
      : (() => {
          try {
            return new URL(String(event.properties.$current_url ?? '/'), origin).pathname;
          } catch {
            return '/';
          }
        })();
  const privatePage = isPrivatePath(pathname);

  scrubBag(event.properties, origin);
  scrubBag(event.$set, origin);
  scrubBag(event.$set_once, origin);

  if (privatePage) {
    delete event.properties.title;
    delete event.properties.$title;
    delete event.properties.$elements;
    const text = event.properties.$el_text;
    if (typeof text !== 'string' || !ui?.has(text)) delete event.properties.$el_text;
    const chain = event.properties.$elements_chain;
    if (typeof chain === 'string') {
      event.properties.$elements_chain = chain.replace(
        CHAIN_TEXT,
        (whole, key: string, value: string) =>
          CHAIN_UI_TEXT.has(key) && ui?.has(value.replace(/\\(.)/g, '$1')) ? whole : '',
      );
    }
  }
  return event;
}

// ── Session replay (rule 4) ──────────────────────────────────────────────

/** Days after sign-up during which every session is recorded: activation happens here. */
export const REPLAY_NEW_USER_DAYS = 14;

/**
 * The share of sessions recorded, by who the visitor is. The free plan stops
 * at 5,000 recordings a month. Traffic in the week to 2026-11-19: 2,097
 * signed-in sessions (1,144 from people in their first three weeks) and
 * ~4,900 anonymous ones. Each rate is at least the one after it, so a
 * session recorded while anonymous stays recorded after sign-in.
 */
export const REPLAY_RATES = { new_user: 1, signed_in: 0.1, anonymous: 0.02 } as const;
export type ReplayTier = keyof typeof REPLAY_RATES;

const DAY_MS = 86_400_000;

/** `signedUpAt`: the Supabase user's `created_at`; null when nobody is signed in. */
export function replayTier(signedUpAt: string | null, now: number): ReplayTier {
  if (signedUpAt === null) return 'anonymous';
  const created = Date.parse(signedUpAt);
  return Number.isFinite(created) && now - created < REPLAY_NEW_USER_DAYS * DAY_MS
    ? 'new_user'
    : 'signed_in';
}

/** A fraction in [0, 1) that depends only on the session id (FNV-1a, 32 bit). */
export function sessionFraction(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Whether this session is recorded. A rejection in the banner always wins. */
export function shouldRecordSession(input: {
  replay: boolean;
  consent: AnalyticsConsent;
  tier: ReplayTier;
  sessionId: string;
}): boolean {
  if (!input.replay || input.consent === 'denied') return false;
  return sessionFraction(input.sessionId) < REPLAY_RATES[input.tier];
}

function withoutLocale(pathname: string): string {
  const segments = pathname.split('/');
  return segments.length > 1 && (locales as readonly string[]).includes(segments[1]!)
    ? `/${segments.slice(2).join('/')}`
    : pathname;
}

/**
 * Whether a recording hides text here. A signed-in person sees their own
 * workspace on every page; a sign-in page shows the email being typed.
 */
export function replayMasksPage(pathname: string, signedIn: boolean): boolean {
  if (signedIn || isPrivatePath(pathname)) return true;
  const path = withoutLocale(pathname);
  return path === '/auth' || path.startsWith('/auth/');
}

/**
 * Message and document text: hidden in a masked recording even where a word
 * equals our interface text. `.kortix-markdown` is every rendered message,
 * document and file preview; `data-replay-content` marks other text a person
 * or an agent wrote (the user message bubble).
 */
export const REPLAY_CONTENT_SELECTOR = '.kortix-markdown, [data-replay-content]';

/** Frames, plugins and anything a component marks with `ph-no-capture` record as an empty box. */
export const REPLAY_BLOCK_SELECTOR = 'iframe, object, embed';

const REPLAY_MASK = '***';

/** Every visible character becomes `*`; spaces stay, so the layout keeps its shape. */
export function maskReplayText(text: string): string {
  return text.replace(/\S/g, '*');
}

/**
 * Attributes a masked recording keeps unchanged: layout, state and styling.
 * None of them carries text a person wrote or named. Everything else that is
 * not a URL (`title`, `alt`, `aria-label`, `placeholder`, `value`, `id`,
 * `name`, `content`, other `data-*`) becomes `***`.
 */
const REPLAY_KEPT_ATTRIBUTES = new Set([
  'class',
  'role',
  'type',
  'dir',
  'lang',
  'tabindex',
  'charset',
  'rel',
  'as',
  'media',
  'sizes',
  'crossorigin',
  'loading',
  'decoding',
  'target',
  'disabled',
  'hidden',
  'open',
  'checked',
  'selected',
  'readonly',
  'required',
  'multiple',
  'draggable',
  'contenteditable',
  'spellcheck',
  'inputmode',
  'colspan',
  'rowspan',
  'cols',
  'rows',
  'span',
  'start',
  'reversed',
  // SVG geometry and paint.
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'xmlns',
  'xmlns:xlink',
  'version',
  'focusable',
  'd',
  'fill',
  'fill-rule',
  'fill-opacity',
  'clip-rule',
  'clip-path',
  'mask',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'stroke-miterlimit',
  'opacity',
  'transform',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'vector-effect',
  'shape-rendering',
  // State that styling reads.
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-pressed',
  'aria-hidden',
  'aria-disabled',
  'aria-current',
  'aria-haspopup',
  'aria-modal',
  'aria-orientation',
  'aria-busy',
  'aria-invalid',
  'aria-level',
  'aria-valuenow',
  'aria-valuemin',
  'aria-valuemax',
  'aria-sort',
  'aria-live',
  'data-state',
  'data-side',
  'data-align',
  'data-orientation',
  'data-slot',
  'data-disabled',
  'data-highlighted',
  'data-selected',
  'data-active',
  'data-variant',
  'data-size',
  'data-theme',
  'data-sidebar',
  'data-collapsible',
  'data-open',
  'data-closed',
  'data-starting-style',
  'data-ending-style',
]);

/** Attributes whose value is one URL. */
const REPLAY_URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'xlink:href',
  'data',
  'cite',
  'background',
]);

/** Attributes whose value is a list of URLs: dropped. */
const REPLAY_URL_LIST_ATTRIBUTES = new Set(['srcset', 'imagesrcset', 'ping']);

/**
 * A link or source in a masked recording. Our origin keeps its path (a route
 * template on private pages) without query or hash: our own assets still
 * render. Another origin keeps only its host. `mailto:`, `data:`, `blob:`
 * and the rest become empty.
 */
export function replayUrl(value: string, origin: string): string {
  if (value.startsWith('#')) return '#';
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.origin !== origin) return `${url.origin}/`;
  return `${url.origin}${sanitizePath(url.pathname)}`;
}

/**
 * The value a recording stores for one attribute. rrweb's own attributes
 * (`rr_width`, `_cssText`, …) always pass: they hold layout and our CSS.
 * Unmasked pages hide only `value`, which rrweb records unmasked for hidden
 * inputs. On a masked page a text attribute (`title`, `aria-label`,
 * `placeholder`, …) keeps a value that is our own interface text (`ui`).
 */
export function replayAttribute(
  name: string,
  value: string,
  masked: boolean,
  origin: string,
  ui?: UiText,
): string {
  const key = name.toLowerCase();
  if (!value || key.startsWith('rr_') || key.startsWith('_')) return value;
  if (key === 'value') return REPLAY_MASK;
  if (!masked || REPLAY_KEPT_ATTRIBUTES.has(key)) return value;
  if (key === 'style') return value.replace(/url\([^)]*\)/gi, 'url()');
  if (REPLAY_URL_ATTRIBUTES.has(key)) return replayUrl(value, origin);
  if (REPLAY_URL_LIST_ATTRIBUTES.has(key)) return '';
  return ui?.has(value) ? value : REPLAY_MASK;
}
