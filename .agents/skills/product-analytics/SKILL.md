---
name: product-analytics
description: "Kortix product analytics and campaign attribution in PostHog (EU Cloud): which events exist, where they fire (web or API), the privacy rules every event must keep, how a promo video or ad link must be tagged, and how to verify an event. Load before adding or renaming an analytics event, touching apps/web/src/lib/analytics or apps/api/src/shared/product-analytics.ts, preparing a campaign link, or answering \"where did our users come from\"."
---

# Product analytics

One PostHog project on EU Cloud collects kortix.com: **Kortix**, project
`334925` (https://eu.posthog.com/project/334925, free plan). The web app and
the API send to it with the same distinct id, the Supabase user id, so the
browser journey, the server events and the first-touch campaign meet on one
person.

| Part | File |
|---|---|
| Hosts that report, consent, URL scrubbing, session replay rules | `apps/web/src/lib/analytics/posthog-config.ts` (+ `.test.ts`) |
| The browser client (init, consent switch, masking) | `apps/web/src/lib/analytics/posthog-client.ts` |
| Start, identify, per-page rules | `apps/web/src/components/analytics/posthog-host.tsx` |
| Browser events (closed list) | `apps/web/src/lib/track.ts` |
| Server events (closed list) | `apps/api/src/shared/product-analytics.ts` |
| Events that know only the account (billing, trigger fires) | `apps/api/src/iam/account-analytics.ts` |
| Route events for the person behind a request | `apps/api/src/projects/routes/product-events.ts` |
| The request surface (`source`) | `apps/api/src/middleware/analytics-source.ts` |
| Dashboards as code | `infra/posthog/` |
| Same-origin proxy `/ingest` | `apps/web/next.config.ts` rewrites |

## Rules

1. **No customer data in an event.** Properties are kinds, counts, USD amounts,
   our own route names and our own ids. Never a name, an email, a prompt, a
   message, a file name, a title, a URL query, a trigger or connector slug, a
   secret name, or anything a customer typed. `identify` sends the user id
   only (decision 2026-11-04: data minimization). The CLAUDE.md PII rule
   applies to PostHog too.
2. **Every event name is in a closed list.** Web: `PANEL_EVENTS`,
   `JOURNEY_EVENTS` or `PERFORMANCE_EVENTS` in `track.ts`. API: the `ProductEvent` union. Never call
   `posthog.capture` directly.
3. **A business fact is an API event.** Sign-up, project, session, message,
   checkout and payment events fire on the server after the database write. The
   browser loses events to ad blockers; the server does not.
4. **Only production reports** (decision 2026-11-06; the free plan has one
   project). The web client reports on `kortix.com` only; dev, staging, self-host,
   white-label and preview hosts never download posthog-js. The API sends only
   where `POSTHOG_PROJECT_KEY` is set: the prod blob, not dev or staging.
   Every event carries `environment`.
   A self-hosted, white-label or preview host never downloads posthog-js. The
   API sends only when `POSTHOG_PROJECT_KEY` is set.
5. **URLs are reduced before they leave the browser.** On signed-in and
   capability-token pages (`isAnalyticsExcludedPath`) a path becomes a route
   template (`/projects/:id/sessions/:id`). Only `utm_*` and ad click ids
   survive a query string. Autocapture text and link targets are removed on
   those pages.
6. **Consent decides storage.** Until the CookieYes banner grants analytics,
   the anonymous id lives in memory only (no cookie, no local storage). A grant
   switches to `localStorage+cookie`. A signed-in user without consent starts
   with their own user id (`bootstrap`), so no anonymous id is merged per page.
7. **Session replay with content hidden** (decision 2026-11-19; it replaced
   "no replay" from 2026-11-04). The rules are rule 4 in `posthog-config.ts`:
   - Who is recorded: everyone except a visitor who rejected analytics in the
     banner. `REPLAY_RATES`: every session of a person in their first 14 days
     after sign-up, 10 % of other signed-in sessions, 2 % of anonymous ones.
     The free plan stops at 5,000 recordings a month; change the rates there.
   - Where: kortix.com only (`REPLAY_HOSTS`). loopmaxxing.sh joins when its
     CookieYes banner loads there; until then a visitor there cannot reject.
   - What is hidden: for a signed-in person, and on private and `/auth` pages,
     every text node becomes `*` and every attribute that can carry text
     becomes `***` (`replayAttribute`), except our own interface text. Every
     input is masked, links to another origin keep only the host, image
     sources lose everything off our origin, and frames record as empty boxes.
     A component that must never appear even as a shape takes the
     `ph-no-capture` class. Page URLs follow rule 5.
   - Interface text (`UiTextIndex`, `apps/web/src/lib/analytics/replay-text.ts`):
     every string of the translation catalog the page renders, the provider
     names, the locale's relative times ("6 minutes ago") and the session
     screen's English labels that code builds outside the catalog
     (`replay-labels.ts`: step summaries, thought rows, tool verbs). Each
     placeholder may stand only for a number: `{count} models` shows
     "14 models" and hides "Acme models". Text with no letter never shows.
     Parts joined by ` · ` or ` — ` are judged one by one; clauses joined by
     `, ` show only when every clause is ours. Everything else hides, so a new
     screen with customer content is hidden without a mark. A row that names
     a file or a command renders the verb in its own text node, so the verb
     shows and the object hides. Text that is not ours (model names and
     provider names that come from the API) stays hidden. When a replay of the
     session screen hides a label of ours, add it to `replay-labels.ts`. Message and document text
     never shows, even where a word equals our text: `.kortix-markdown` and
     `[data-replay-content]` (the user message bubble), `REPLAY_CONTENT_SELECTOR`.
     Mark other text a person or an agent wrote with `data-replay-content`. A click event on a
     private page keeps the same interface text in `$el_text` and the
     element chain, and loses the rest (`scrubEvent`).
   - The recorder (`posthog-js/dist/posthog-recorder`, 66 KB gzip) downloads
     only for a recorded session.
   - The privacy policy (`/legal`, cookies section) and the PostHog row in
     `packages/shared/src/subprocessors.ts` describe this. Change them with
     the rules.
8. **A person's events only.** Route events go through `capturePersonEvent`
   (`projects/routes/product-events.ts`): an agent's session token, an API
   key, a service account or an OAuth app sends nothing. Server-side session
   and turn events count only sessions with `initiator_type = member`. One
   exception, decided 2026-11-20: the `setup_*` events accept a session's own
   token, because a person often asks the Kortix agent to run the setup. They
   count as the person who started the session, with `agent = kortix`, and
   only when `initiator_type = member`.

## Events

| Event | From | Fires when | Properties |
|---|---|---|---|
| `$pageview`, `$pageleave`, `$autocapture` | web | navigation, clicks | scrubbed URL, `environment`, `platform` (`web`/`desktop`), `app_version` |
| `cta_signup_clicked` | web | a sign-up button on a marketing page | `location` |
| `auth_completed` | web | the browser lands after sign-up or sign-in | `kind` (`signup`/`login`), `method` |
| `screen_ready` | web | an app screen (signed-in and token pages; Speed Insights covers the rest) shows its data, once per navigation (`lib/analytics/screen-timing.ts`): the React Query reads behind it settled (no request for 0.5 s), or, on the session screen, the saved conversation is visible. A new session, a fully cached screen, a hidden tab and anything over 60 s send nothing | `screen` (route template, `/workspaces/:id`), `duration_ms`, `navigation` (`load`: from the browser's navigation start; `route`: from the in-app route change), `fetches` (React Query fetches it took) |
| `setup_prompt_copied` | web | a Loopmaxxing copy button (or its C key) put the setup prompt on the clipboard | `template` (the one the prompt names, else `none`), `method` (`button`/`key`), `location` |
| panel events (`panel_opened`, …) | web (`@kortix/ui`) | session panel and conversation UI | `source`, `kind`, `count` |
| `user_signed_up` | API | a new person's first `GET /v1/accounts` with no workspace (`accounts/core/signup-event.ts`) | `method` (email, google, github, apple), `invited` (an invitation to the email was open at sign-up); sets the person property `signup_kind` (`invited`, `self_serve`) once |
| `user_logged_in` | API | a CLI device login or a headless sign-in (not a token refresh) | `method` |
| `project_created` | API | a project is provisioned or linked | `origin` (blank, template, github_import; `marketplace` until 2026-11-20), `provider` |
| `session_created` | API | a person creates a session (not triggers, channels, agents) | `session_id`, `source`, `with_prompt` |
| `session_started` | API | the session's runtime answers for the first time in one boot: first open, every wake after sleep, every restart. It counts boots, not sessions | `provider`, `boot_ms` |
| `session_restarted` | API | a person restarts a session | `provider` |
| `session_stopped` | API | a person's session's sandbox stops | `reason`, `active_ms` |
| `prompt_sent` | API | a person sends a prompt: the prompt POST, or inside the session create (workspace home, mobile, sessions board) | `model` (`default` = the project default), `attachment_count`, `at_create` |
| `turn_completed` | API | an agent turn of a person's session ends | `status` (ok, error, aborted), `end_reason`, `duration_ms` |
| `secret_created` | API | a new project secret (never its name or value) | `name_kind` (provider, other), `strategy` |
| `provider_configured` | API | an LLM provider is connected | `provider`, `method` (api_key, oauth, subscription) |
| `provider_verified` | API | a provider credential check | `provider`, `state` |
| `model_changed` | API | a person switches a session's model | `from`, `to`, `live_push` |
| `connector_added` | API | a connector is added (never its slug) | `provider`, `app` |
| `connector_connected` | API | a connector finishes connecting | `method`, `provider` |
| `trigger_created` | API | a trigger is created (never its slug) | `type` |
| `trigger_fired` | API | a trigger started or queued a run (account owner) | `fire_source`, `status`, `deduped` |
| `app_deployed` | API | an app deployment is queued | `app_kind`, `hosting_provider`, `actor_type` |
| `feature_flag_toggled` | API | a project feature flag is set or cleared | `key`, `enabled` |
| `billing_gate_hit` | API | a person is refused for billing | `reason`, `where` (session_create, session_start, prompt, model_switch) |
| `checkout_started` | API | a Stripe checkout is created | `kind`, `tier`, `amount_usd` |
| `subscription_activated` | API | a paid plan becomes active (Stripe or app store) | `tier`, `amount_usd`, `store`, `via` |
| `subscription_cancelled` | API | a paid plan ends | `store`, `previous_tier`, `amount_usd` |
| `credits_topped_up` | API | a one-off credit purchase is paid | `amount_usd`, `store` |
| `member_joined` | API | a person joins a workspace someone else made | `via` (invite, auto_claim, direct_add, project_invite, access_request), `role` |
| `setup_started` | API (CLI) | `kortix plan`, step 1 of /setup.md: a setup run starts (once per `setup_id`) | `has_workspace`, `has_manifest` |
| `setup_template_added` | API (CLI) | `kortix templates add` inside a setup run | `template` |
| `setup_onboard_run` | API (CLI) | each `kortix onboard` inside a setup run | `exit_code`, `phase_<name>` (done, skipped, waiting_on_person, failed), `wait`, `waited_s`, `duration_s`, `steps_left`, `connectors`, `secrets`, `sandbox_templates`, `slack`, `project_id` |
| `setup_ready` | API (CLI) | the first green `kortix onboard` or `kortix doctor --loops` of a run (once per `setup_id`) | `via`, `minutes_since_start`, `project_id` |

The four `setup_*` API events come from the CLI through `POST /v1/cli/setup-events`
(`apps/api/src/cli/setup-events.ts`, closed schema, 20 a minute per person) and
`apps/cli/src/setup-telemetry.ts`. Each carries `setup_id` (one guided setup:
`kortix plan` starts it, it ends 24 hours after its last event), `agent` (the
coding agent, from `AI_AGENT`, `CLAUDECODE` and each tool's marker; the API
sets `kortix` for a session's own token) and `cli_version`. Inside a Kortix
session the CLI sends with the session's token, and the route counts the
event for the person who started the session (rule 8). The token of a
trigger, channel, API or system session gets `202 {accepted: false}`. Outside a run the CLI sends nothing; `DO_NOT_TRACK=1` or
`KORTIX_TELEMETRY=0` turns it off.

Request-driven events carry `source` (web, cli, mobile, desktop). API events
that two code paths can report carry a fixed uuid (`dedupeKey`), and the
Stripe activation and credit grant report only when their keyed wallet grant
was not a replay.

## Activation funnels

The Kortix · Activation dashboard has two funnels, both inside 24 h. A
completed turn is `turn_completed` with `status = ok`: a failed turn (no
model, a plan refusal) also fires `turn_completed`.

| Funnel | Steps |
|---|---|
| Self-serve | `user_signed_up` (`invited` ≠ true) → `project_created` → `provider_configured` (optional step) → `session_created` → `prompt_sent` → `turn_completed` ok |
| Invited | `member_joined` → `session_created` → `prompt_sent` → `turn_completed` ok |

- `provider_configured` is optional because only the Free plan needs a
  connected provider: it cannot use Kortix models (`plan_upgrade_required`).
  A paid plan skips the step and still counts.
- The funnels use `session_created`, not `session_started`: one session boots
  many times.
- An invited person never creates a workspace, so the self-serve funnel would
  count them as lost at `project_created`.

## Campaign attribution

PostHog stores the first campaign a person arrived with as person properties
(`$initial_utm_source`, `$initial_utm_campaign`, `$initial_gclid`,
`$initial_fbclid`, `$initial_referring_domain`, …). Every later event, including
`subscription_activated` from the API, can be broken down by them. Ad platforms
that add a click id (`gclid`, `fbclid`, `msclkid`, `li_fat_id`, `ttclid`) need
no tagging beyond their own auto-tagging.

Tag every link we publish. Lowercase, `_` between words, no spaces:

| Parameter | Meaning | Example values |
|---|---|---|
| `utm_source` | where the link sits | `youtube`, `x`, `linkedin`, `instagram`, `tiktok`, `newsletter`, `podcast`, `producthunt` |
| `utm_medium` | the kind of placement | `video`, `social`, `paid_social`, `cpc`, `email`, `partner` |
| `utm_campaign` | the launch or campaign | `launch_2026_11`, `promo_video_1` |
| `utm_content` | the variant, when there are several | `cut_30s`, `thumbnail_b`, `pinned_comment` |

Examples:

- YouTube video description:
  `https://kortix.com/?utm_source=youtube&utm_medium=video&utm_campaign=promo_video_1`
- The same video's pinned comment:
  `…&utm_content=pinned_comment`
- A paid Meta ad: `?utm_source=meta&utm_medium=paid_social&utm_campaign=launch_2026_11&utm_content=cut_30s`

A viewer who types `kortix.com` by hand arrives as `$direct`. The PostHog
survey "Acquisition: how did you hear about us" catches them: one question,
shown once, 15 s after an app page (`/projects…`, now `/workspaces`) loads, to
people whose `signed_up_at` is within 7 days — and only once a workspace
exists: automatic survey display is off (`posthog-client.ts`) because the
survey pinned the create-first-workspace landing of an empty account behind
itself (dogfood signature `dogfood:auth-signup-onboarding:survey-modal-blocks-first-landing`).
The chooser displays it through `apps/web/src/lib/analytics/survey-gate.ts`.
The answer is the event property
`$survey_response_709452a5-5925-4704-a85a-0618d2f78ed3` on `survey sent`.

## Where to look

The dashboards are code: `infra/posthog/` (Terraform, state in S3; see its
README). They follow the design of the closed PR #7144.

| Question | Dashboard |
|---|---|
| Do new users reach a completed turn, and how fast? Self-serve and invited apart | Kortix · Activation |
| DAU/WAU/MAU, retention, stickiness, surface mix | Kortix · Engagement |
| Providers, key checks, prompts by model | Kortix · Providers & models |
| Boot time, active time, turn outcomes | Kortix · Sessions |
| Connectors, secrets, triggers, apps, flags, billing gates | Kortix · Setup & adoption |
| How long screens take to show their data, by continent, country and screen (`screen_ready`) | Kortix · Speed |
| Visitors, referrers, UTM, landing pages, first-touch signups, survey answers | Kortix · Acquisition |
| Goals, visitor → paid, signup → paid, time to paid | Kortix · Conversion |
| Does the setup prompt end in working loops, which coding agent ran it, where onboard stops | Kortix · Setup |
| One person's journey | PostHog → People → the person → Events |

Every insight sets `filterTestAccounts`: `environment = production`, and the
person is not in the cohort "Internal / Test users" (311084). Local, dev and
staging events never reach the charts.

### Kortix staff are out of every chart

- The cohort holds every person with `$internal_or_test_user = true`. Persons
  carry no email (rule 1), so the filter's email conditions match nobody: the
  flag is what excludes staff.
- The API sets the flag (`flagStaffOnce` in `shared/product-analytics.ts`): the
  first event of a person in each API process reads their email from
  `auth.users`, and a `@kortix.ai` or `@kortix.com` address sends one `$set`.
  PostHog gets the flag, never the email. Web events land on the same person,
  so they drop out too.
- Cohort membership is read when a chart runs, so a flag also hides the
  person's earlier events. The cohort is dynamic: a new flag counts after its
  next recalculation (hours).
- A teammate who uses a personal email: set `$internal_or_test_user = true` on
  their person by hand (PostHog → People → the person → Properties).
- 2026-11-19: 23 staff persons were flagged once by hand (prod `auth.users`
  ids on the two domains that PostHog knew, plus one personal account).

## PostHog project settings (set 2026-11-04, replay 2026-11-19)

- Session replay on. Recording domain `https://kortix.com`, 2 s minimum,
  console and network capture off, 30-day retention, no sample rate and no URL
  blocklist: the web client decides which sessions record and what they hide
  (rule 7). The project switch alone records nothing: the client starts
  every recording itself.
- Surveys on. Authorized URL `https://kortix.com` (toolbar, heatmaps).
- IP anonymization on; GeoIP country and city still resolve.
- Free plan hard limits: 1 M events a month. Past it PostHog drops events until
  the next cycle; nothing is billed. Add a card and a billing limit before
  traffic approaches it.
- A survey created through the API with `start_date` keeps its targeting flag
  inactive. Activate the flag (`PATCH /api/projects/334925/feature_flags/<id>/
  {"active": true}`) or launch from the UI.

## Where the key lives

- Web: `POSTHOG_PROJECT_KEY` in `posthog-config.ts`, used on `kortix.com` only.
  No hosting setting is involved.
- API: `POSTHOG_PROJECT_KEY` in the prod Secrets Manager blob `kortix-prod-env`
  (eu-west-2), mirrored in `apps/api/.env.prod` (the dotenvx-secrets skill).
  `kortix-dev-env` and `kortix-staging-env` do not carry it (removed
  2026-11-06), so dev and staging send nothing. Unset = no server events.

## PostHog MCP

`claude mcp add --transport http posthog https://mcp.posthog.com/mcp -s user`,
then `/mcp` in Claude Code to log in (OAuth, picks the EU region). It answers
analytics questions and edits insights, dashboards and surveys directly.

## Verify an event

Never point a test at the Kortix project. Use your own free PostHog project,
or a local capture sink that logs what the API sends.

1. Web, local: put your own project's `NEXT_PUBLIC_POSTHOG_KEY=phc_…` in
   `apps/web/.env.local`. A localhost run reports only with this variable, as
   `environment=local`, and keeps bot traffic (scripted browsers) tagged
   `$browser_type: bot`.
2. In the browser console run `localStorage.setItem('ph_debug', 'true')` and
   reload: posthog-js logs every event with its properties before it sends it.
3. Web, local, with a sink: also set `POSTHOG_INGEST_ORIGIN=http://127.0.0.1:<port>`
   in `apps/web/.env.local`. The `/ingest` rewrite then sends there. The sink
   answers `/array/<key>/config` and `/flags/` with
   `{"sessionRecording": {"endpoint": "/s/"}, "supportedCompression": ["gzip-js"]}`
   and logs every POST body (gzip; snapshot fields inside are gzip strings
   too). To prove replay masking, sign in as a user whose email, name and
   workspace name are unique strings, then search the logged `/s/` bodies for
   them: the count must be 0.
4. API, local: set `POSTHOG_PROJECT_KEY` (your project, or any `phc_` value)
   and `POSTHOG_HOST=http://localhost:<port>` (a sink that logs each `/batch/`
   body) in `apps/api/.env.local`, trigger the action, read the sink.
5. Production: PostHog → Activity, filter `environment = production`. The
   dashboards apply the project's test-account filter by default.
