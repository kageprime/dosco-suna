/**
 * Product analytics from the API: the business events of the acquisition and
 * activation funnel, sent to the same PostHog project as the web app
 * (apps/web/src/lib/analytics/posthog-client.ts). The browser can lose events
 * to an ad blocker or a closed tab; these cannot be lost that way, and they
 * fire only after the database write succeeded.
 *
 * - The distinct id is the Supabase user id, the id the web app identifies
 *   with, so server and browser events land on one person and that person's
 *   first-touch campaign (`$initial_utm_*`, click ids) attributes them.
 * - Properties are kinds, amounts in USD and our own ids. Never a name, an
 *   email, a prompt, a file or anything a customer typed.
 * - Off unless POSTHOG_PROJECT_KEY is set: self-host, tests and local runs send
 *   nothing. Never throws, never awaits on a request path.
 * - Events that two code paths can both report (a subscription activated by
 *   checkout and by its first invoice) carry `dedupeKey`. It becomes a fixed
 *   event uuid, and PostHog keeps one event per uuid.
 * - Kortix staff are flagged, not dropped: the first event of a person whose
 *   email is on a staff domain also sets `$internal_or_test_user` on the
 *   PostHog person (`flagStaffOnce`). PostHog gets the flag, never the email.
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { PostHog } from 'posthog-node';

import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from './db';
import { isUuid } from './validate';

/**
 * The event contract. Names and properties follow the dashboards in
 * infra/posthog/dashboards.tf: change an event here, change the insight there.
 */
export type ProductEvent =
  // Acquisition and activation
  /**
   * A new person reached Kortix for the first time (accounts/core/signup-event.ts). `method`: auth provider,
   * `invited`: an invitation to their email was open at sign-up. Sets the person property `signup_kind`
   * (invited | self_serve) once.
   */
  | 'user_signed_up'
  /** A CLI or device login completed. `method`. */
  | 'user_logged_in'
  /** A project was created. `origin`: blank | template | github_import (`marketplace` until 2026-11-20). */
  | 'project_created'
  /** A person created a session (not a trigger, channel or agent). `source`. */
  | 'session_created'
  /** A session's runtime answered for the first time in one boot: every boot, wake and restart. `provider`, `boot_ms`, `stage`. */
  | 'session_started'
  /** A person restarted a session. `provider`. */
  | 'session_restarted'
  /** A session's sandbox stopped. `reason`, `active_ms`. */
  | 'session_stopped'
  /** A person sent a prompt, in the prompt POST or inside the session create (`at_create`). `model`, `attachment_count`, `source`. */
  | 'prompt_sent'
  /** An agent turn ended. `status`: ok | error | aborted, `end_reason`, `duration_ms`. */
  | 'turn_completed'
  // Setup and adoption
  /** A project secret was saved. `name_kind`: provider | other. Never the name or value. */
  | 'secret_created'
  /** An LLM provider was connected. `provider`, `method`: api_key | oauth | subscription. */
  | 'provider_configured'
  /** A provider credential was checked. `provider`, `state`. */
  | 'provider_verified'
  /** A person switched a session's model. `from`, `to`. */
  | 'model_changed'
  /** A connector was added to a project. `provider`, `slug` (the app, e.g. gmail). */
  | 'connector_added'
  /** A connector finished connecting. `slug`, `method`: credential | oauth. */
  | 'connector_connected'
  /** A trigger was created. */
  | 'trigger_created'
  /** A trigger fired. `fire_source`: manual | cron | webhook, `deduped`. */
  | 'trigger_fired'
  /** An app was deployed. `app_kind`, `hosting_provider`. */
  | 'app_deployed'
  /** A project feature flag was toggled. `key`, `enabled`. */
  | 'feature_flag_toggled'
  /** A person joined a workspace someone else created. `via`: invite | auto_claim | direct_add | project_invite | access_request, `role`. */
  | 'member_joined'
  // Revenue
  /** A request was refused for billing. `reason`, `where`. */
  | 'billing_gate_hit'
  /** A Stripe checkout was created. `kind`: subscription | credits, `tier`, `amount_usd`. */
  | 'checkout_started'
  /** A paid plan became active. `tier`, `amount_usd` per month, `store`, `via`. */
  | 'subscription_activated'
  /** A paid plan ended. `store`, `previous_tier`, `amount_usd`. */
  | 'subscription_cancelled'
  /** A one-off credit purchase was paid. `amount_usd`, `store`. */
  | 'credits_topped_up'
  // Guided setup (/setup.md), reported by the CLI through POST /v1/cli/setup-events (cli/setup-events.ts).
  // Every one carries `setup_id` (one run), `agent` (the coding agent running the guide) and `cli_version`.
  /** `kortix plan`, the guide's step 1. `has_workspace`, `has_manifest`. Once per setup_id. */
  | 'setup_started'
  /** `kortix templates add`. `template`: our template id. Once per setup_id and template. */
  | 'setup_template_added'
  /** Each `kortix onboard` run. `exit_code`, `phase_<name>` statuses, `waited_s` on the setup page, `steps_left`, counts. */
  | 'setup_onboard_run'
  /** The first green `kortix doctor --loops` or onboard. `via`, `minutes_since_start`. Once per setup_id. */
  | 'setup_ready';

export type ProductEventProperties = Record<string, string | number | boolean | null | undefined>;

export interface ProductEventInput {
  /** The Supabase user id of the person the event belongs to. */
  userId: string;
  event: ProductEvent;
  accountId?: string;
  properties?: ProductEventProperties;
  /** Any stable string; the same key always yields the same event uuid. */
  dedupeKey?: string;
  /** Person properties PostHog sets only when the person has none yet (`$set_once`). */
  personPropertiesOnce?: Record<string, string>;
}

// replica-local: one client per process, created on first use.
let client: PostHog | null | undefined;

function analyticsClient(): PostHog | null {
  if (client !== undefined) return client;
  client = config.POSTHOG_PROJECT_KEY
    ? new PostHog(config.POSTHOG_PROJECT_KEY, {
        host: config.POSTHOG_HOST,
        flushAt: 20,
        flushInterval: 10_000,
        requestTimeout: 10_000,
        // Server events carry the API's address, not the visitor's.
        disableGeoip: true,
      })
    : null;
  return client;
}

/** A UUID (version 5 layout) derived from `key`. */
export function stableEventUuid(key: string): string {
  const hex = createHash('sha256').update(`kortix-product-event:${key}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Kortix staff: a person whose email is on one of these domains. PostHog's
 * "Internal / Test users" cohort holds every person with
 * `$internal_or_test_user = true`, and every dashboard filters that cohort out
 * (`filterTestAccounts`, infra/posthog). Cohort membership is read when a chart
 * runs, so the flag also hides the person's earlier events. A teammate on a
 * personal email is flagged by hand on their PostHog person.
 */
const STAFF_EMAIL_DOMAINS = new Set(['kortix.ai', 'kortix.com']);

/** True for an address on a staff domain: `a@kortix.ai`, not `a@kortix.ai.example.test`. */
export function isStaffEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  return at > 0 && STAFF_EMAIL_DOMAINS.has(email.slice(at + 1).trim().toLowerCase());
}

const CHECKED_PEOPLE_MAX = 50_000;
// replica-local: the user ids this process already checked; each process checks a person once.
const checkedPeople = new Set<string>();

async function isStaffUser(userId: string): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT email FROM auth.users WHERE id = ${userId}::uuid`,
  )) as unknown as Array<{ email: string | null }>;
  return isStaffEmail(rows[0]?.email);
}

/**
 * Once per person and process: read the person's email and, for staff, set
 * `$internal_or_test_user` on their PostHog person. Never awaited; a failed
 * read is retried with the person's next event.
 */
function flagStaffOnce(posthog: PostHog, userId: string): void {
  // config.DATABASE_URL is what db.ts exports as hasDatabase. Reading config keeps this
  // module loadable under the many unit tests that mock ./db with `db` alone.
  if (!config.DATABASE_URL || !isUuid(userId) || checkedPeople.has(userId)) return;
  if (checkedPeople.size >= CHECKED_PEOPLE_MAX) checkedPeople.clear();
  checkedPeople.add(userId);
  isStaffUser(userId).then(
    (staff) => {
      if (!staff) return;
      posthog.capture({
        distinctId: userId,
        event: '$set',
        properties: { $set: { $internal_or_test_user: true }, $lib_custom: 'kortix-api' },
      });
    },
    () => {
      checkedPeople.delete(userId);
    },
  );
}

/** Queue one event. Returns at once; delivery is batched in the background. */
export function captureProductEvent(input: ProductEventInput): void {
  const posthog = analyticsClient();
  if (!posthog || !input.userId) return;
  try {
    posthog.capture({
      distinctId: input.userId,
      event: input.event,
      uuid: input.dedupeKey ? stableEventUuid(`${input.event}:${input.dedupeKey}`) : undefined,
      properties: {
        ...input.properties,
        account_id: input.accountId,
        // A local stack runs as INTERNAL_KORTIX_ENV=dev; keep it out of dev's numbers.
        // The web client's names: `production`, `staging`, `dev`, `local`.
        environment: config.KORTIX_LOCAL_DEV
          ? 'local'
          : config.INTERNAL_KORTIX_ENV === 'prod'
            ? 'production'
            : config.INTERNAL_KORTIX_ENV,
        $lib_custom: 'kortix-api',
        ...(input.personPropertiesOnce ? { $set_once: input.personPropertiesOnce } : {}),
      },
    });
    flagStaffOnce(posthog, input.userId);
  } catch (error) {
    logger.warn('[product-analytics] capture failed', {
      event: input.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Send what is queued. Called once by the shutdown sequence. */
export async function shutdownProductAnalytics(): Promise<void> {
  if (!client) return;
  await client.shutdown(5_000).catch(() => {});
}
