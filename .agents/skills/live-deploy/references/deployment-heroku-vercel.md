# Dosco Deployment: Heroku API + Vercel Frontend + Supabase

Last updated: 2026-10-20

This document records how Dosco is deployed, why the current configuration
looks the way it does, every failure hit during bring-up, and the runbook for
operating it. It is written to be usable by someone who was not in the room.

---

## 1. Architecture

```
Browser
  |
  |  HTTPS
  v
Vercel  (apps/web, Next.js 15)
  |  https://dosco-virid.vercel.app        (current production alias)
  |  https://dosco.live                     (custom domain - DNS pending)
  |
  |  NEXT_PUBLIC_BACKEND_URL = https://dosco-05dd0b153705.herokuapp.com/v1
  v
Heroku  (apps/api, Bun, container stack)
  |  app: dosco
  |  dyno: web.1, Standard-2X (1 GB)
  |
  +--> Supabase Postgres   (Supavisor pooler, IPv4, port 6543)
  +--> Supabase Auth       (email OTP / password / Google OAuth)
  +--> E2B                 (sandbox provider; no Docker-in-Docker)
  +--> Pipedream, GitHub, Paystack, Tavily (optional integrations)
```

Canonical URLs:

| Thing | Value |
|---|---|
| Frontend (current) | `https://dosco-virid.vercel.app` |
| Frontend (intended) | `https://dosco.live` |
| API | `https://dosco-05dd0b153705.herokuapp.com` |
| API health | `/health` and `/health/ready` |
| Supabase project | `<supabase-project-ref>` (eu-west-1) |
| Supabase Auth | `https://<supabase-project-ref>.supabase.co/auth/v1` |
| Heroku app | `dosco` |
| Vercel project | `dosco` / `prj_mEKYUFNPOV6wM5BkWY9qe4e7N2pS` |

---

## 2. Repositories and branches

| Repo / branch | Purpose | Build target |
|---|---|---|
| `kageprime/dosco-suna` `main` | Full source of truth (backend + `apps/web`); unified 2026-10-23 | Vercel + source for both |
| `heroku-clean` | Deploy branch: `main` + the backend-fix commits + ONE Heroku-only patch (`apps/api/Dockerfile` from-lines carry no `--platform`; see 3.1) | Heroku (pushed as Heroku `main`) |

Rules:

- Vercel builds **only** from `main`, with **Root Directory = `apps/web`**.
- Heroku is pushed from `heroku-clean` only; history was unified 2026-10-23, so
  pushes are force-pushes from now on:
  `git push https://heroku:$HEROKU_TOKEN@git.heroku.com/dosco.git +heroku-clean:main --force`
- `heroku-clean` is `origin/main` **plus the deploy-branch commit only**. Keep
  the Dockerfile `--platform` strip OUT of `main`: origin's CI relies on
  `$BUILDPLATFORM` to keep go/agent stages native during emulated arm builds;
  Heroku's docker builder is not BuildKit and parses the token as an empty
  platform instead.
- Heroku builds `apps/api/Dockerfile` via `heroku.yml`; the root `Dockerfile`
  is kept for self-hosted/full deployments.

Local working copies:

- `C:\Users\kage\Desktop\dosco-suna` - backend worktree (currently on
  `heroku-clean`).
- `C:\Users\kage\Desktop\dosco-web` - full frontend source tree used for
  frontend changes.

---

## 3. Heroku (API)

### 3.1 Runtime shape

- Stack: `container`, generation `cedar`.
- Heroku pins the Docker build context to the directory holding the chosen
  Dockerfile (devcenter: _"can't be configured independently"_). The deploy
  therefore uses a repo-root context: `Dockerfile.heroku` at the repo root is a
  byte copy of `apps/api/Dockerfile` with the three `FROM
  --platform=$BUILDPLATFORM` tokens stripped.
- `heroku.yml`:

  ```yaml
  build:
    docker:
      web: Dockerfile.heroku
    config:
      SERVICE: apps/api
  ```

- `heroku.yml` keeps an explicit absolute run line:

  ```yaml
  build:
    docker:
      web: Dockerfile.heroku
    config:
      SERVICE: apps/api
  run:
    web: /app/apps/api/start.sh
  ```

  Heroku executes the run line with `/bin/sh -c`. `start.sh` then
  `exec bun run src/index.ts` from `/app/apps/api`. Never prefix a `cd
  apps/api`: the runner's final `WORKDIR` is already `/app/apps/api`.

- `start.sh` must stay LF-only in the git blob (122 bytes, no `0d` bytes). A
  CRLF launcher cannot exec and produces no useful log line.

- `src/index.ts` imports the assembled app first, then calls `Bun.serve` on
  `config.PORT`. The route graph is evaluated before the listener opens. Boot
  takes ~1 s in the current image, well inside Heroku's 60 s boot timeout.
- Upkeep on every Dockerfile sync from `main`:
  1. `Dockerfile.heroku` is NOT a byte copy of `apps/api/Dockerfile`. It is the
     consolidated Heroku variant. Port source changes by hand and keep the
     final stage at or below **32 instructions** (the final stage of the image
     that boots today). Heroku's Common Runtime refuses images over ~40
     layers, and the failure is silent: no `Starting process` line, no app
     output, `crashed` 2-18 s after start (v39, v41-v55, 2026-10-23).
  2. Keep the three build-context negations after `*.md` in `.dockerignore`:
     `!apps/sandbox/MACHINE.md`, `!apps/kortix-app-runtime/**`,
     `!apps/sandbox/**`. Do NOT add a negation for
     `apps/kortix-sandbox-agent-server/**`: with it, the agent's
     `src/__tests__` enter the build context and the stage's `tsc --noEmit`
     fails on modules only trunk's full context would carry.
  3. Keep the `--platform` strip OUT of `main`: origin's CI relies on
     `$BUILDPLATFORM` to keep the go/agent stages native during emulated arm
     builds.
  4. Give every directory `COPY` source an explicit destination. A merged
     `COPY a b ./target/` copies the *contents* of each directory into
     `target/`, not the directories themselves. This flattened
     `agent-tunnel/src` (boot died with `Cannot find package
     'agent-tunnel'`) and the fingerprint trees `apps/sandbox/slack-cli`,
     `apps/kortix-sandbox-agent-server/src`, and `apps/cli/src` (startup
     pre-build died with `ENOENT ... lstat`), both 2026-10-23. Correct forms:
     `COPY .../agent-tunnel/package.json ./node_modules/agent-tunnel/package.json`
     plus `COPY .../agent-tunnel/src ./node_modules/agent-tunnel/src`.
  5. Debug boot failures on the canary app, never on prod. The canary is kept
     scaled to zero: `heroku ps:scale web=1 -a dosco-boot-debug`, then
     `git push https://git.heroku.com/dosco-boot-debug.git +heroku-clean:main`.
     Inspect the canary image with
     `heroku run --no-tty -a dosco-boot-debug "…"`. It runs the same image
     and config (49 vars copied from prod on 2026-10-23). A green `/health`
     is not a full boot check: also require the startup pre-build `ready`
     line (`heroku logs -a dosco-boot-debug --num 400`).

### 3.2 The 40-layer limit (the original crash)

The first image (root `Dockerfile`) was never killed by the app - the container
never started. Heroku's Common Runtime documentation says:

> "While Docker images are not subject to size restrictions ... they are subject
> to the dyno boot time restriction. As layer count/image size grows, so will
> dyno boot time. As such, images with more than 40 layers may fail to start in
> the Common Runtime."

The original image had roughly 88 layers; the first slim image still had **61
layers** (230.5 MB compressed / 856.6 MB uncompressed) and failed the same way.
Symptoms: `State changed from starting to crashed` ~12-18 s later, with no
`Starting process with command` line and no application stdout.

A minimal probe image (`oven/bun:1.4.3-slim` + a 3-line server) booted in ~2 s
and logged stdout, proving the platform, `$PORT`, egress, and logging were fine.

Fix: the deploy branch carries a consolidated `Dockerfile.heroku`. Its final
stage is **32 instructions** (the unified-tree sync initially reused origin's
`apps/api/Dockerfile` verbatim at **75** — releases v39/v41-v55 crashed on it,
2026-10-23). Consolidation made the container start and exposed a second
defect: merged `COPY` lines had flattened directory sources (see upkeep
rule 4):

- all `pnpm install` work happens in the `deps` stage;
- the runner copies consolidated trees: `node_modules`, `packages`,
  `${SERVICE}` (apps/api), and the app source trees the runtime fingerprints;
- the agent-tunnel workaround and test-file pruning happen in the runner as
  two-copy blocks (see upkeep rule 4);
- only `ca-certificates`, `curl`, and `git` are installed at runtime.

Do not introduce new `COPY`/`RUN` instructions in the runner stage without
counting instructions. Keep the final stage at or below **32 instructions**
(the image that boots today). The previous minimal variant reached 14; the
unified tree needs the extra source copies.

### 3.3 What the image contains

Included:

- Bun 1.4.3 slim base;
- `node_modules` and workspace `packages/*` (including DB migrations and
  starter templates);
- `apps/api`;
- compiled `kortix-agent`, the `kortix` CLI (plus version and connector
  attestation), and the `kortix-appd` / `caddy` linux-amd64 binaries;
- `apps/kortix-sandbox-agent-server` and `apps/cli` **source and
  `package.json`** (the runtime fingerprints read them);
- `apps/sandbox` assets: `entrypoint.sh`, `opencode-warmup.sh`, `MACHINE.md`,
  and the `slack-cli` directory.

Deliberately excluded:

- `docker.io`;
- the other apps (`apps/web`, `apps/mobile`, `apps/desktop-electron`,
  `apps/whitelabel-demo`), tests, and docs.

The runtime fingerprints hash the source trees and the sandbox assets at boot.
A flattened or missing tree fails the startup pre-build with
`ENOENT ... lstat '<path>'` (release v60, 2026-10-23). Give every directory
`COPY` an explicit destination (upkeep rule 4).

### 3.4 Dyno size

- `web.1` runs on **Standard-2X** (1 GB RAM, 2 CPU shares).
- Performance-M/L are rejected on this account:

  ```json
  { "id": "verifiedplus_required",
    "message": "You can't scale dynos on dosco. Only customers with an
    established payment history can use Performance dynos." }
  ```

The layer fix is what made the container boot, not memory. A larger dyno is not
required.

### 3.5 Heroku config vars

Set on the app (values are secrets and live only in Heroku):

| Key | Purpose / notes |
|---|---|
| `DATABASE_URL` | Supabase Supavisor pooler, `...pooler.supabase.com:6543/postgres?sslmode=require` |
| `DB_CONNECT_TIMEOUT_S` | Postgres connect budget |
| `DB_POOL_MAX` | `10` - raised from 6 to survive background-worker contention |
| `SUPABASE_URL` | `https://<supabase-project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin key - **rotate (see section 10)** |
| `JWT_SECRET` | API signing secret |
| `CORS_ALLOWED_ORIGINS` | `https://dosco.live,https://dosco-virid.vercel.app,http://localhost:3000` |
| `FRONTEND_URL` | `https://dosco.live` |
| `KORTIX_URL` | Public API URL |
| `E2B_API_KEY`, `E2B_DOMAIN`, `E2B_WEBHOOK_SECRET` | Sandboxes |
| `SANDBOX_PROVIDER`, `ALLOWED_SANDBOX_PROVIDERS` | Provider selection |
| `KORTIX_CONNECTOR_SWEEP_INTERVAL_MS` | `86400000` - sweep paused for 24 h (see 3.6) |
| `KORTIX_CONNECTOR_PROJECT_CONCURRENCY` | `1` |
| `KORTIX_CONNECTOR_PROJECT_TIMEOUT_MS` | `30000` |
| `KORTIX_TRIGGER_SCHEDULER_ENABLED` | `false` - singleton trigger scheduler disabled (see 3.6) |
| `TUNNEL_ENABLED` | `false` - "Computers" / agent tunnel is off; routes return 503 `tunnel_disabled` (expected) |
| `PIPEDREAM_*` | Present but currently invalid (`401 invalid_client`) |
| `KORTIX_GITHUB_APP_*`, `MANAGED_GIT_*` | GitHub app / managed git |
| `PAYSTACK_*` | Billing |
| `TAVILY_API_KEY` | Search |
| `EMAIL_URL`, `EMAIL_FROM` | Transactional email |
| `KORTIX_PLATFORM_ADMIN_EMAILS` | Admin allowlist |

Config changes restart the dyno automatically and create a release.

### 3.6 Background workers and DB pool starvation

Postgres.js has **no acquire/queue timeout**: once every connection in the pool
is checked out, new queries queue forever. Background trigger/connector workers
(the connector sweep, trigger-event handlers) can hold transactions across
network I/O. On a fresh install with unreachable/misconfigured integrations,
several workers pinned all six connections, so interactive requests waited 25 s
and returned:

```json
{ "error": true, "status": 503, "code": "request_deadline",
  "message": "Request exceeded the 25s server processing deadline" }
```

with `db_pool_wait_suspected: true` and `db;dur=25000;desc="n=1"`.

Mitigations applied (2026-10-20):

- `DB_POOL_MAX=10` (headroom for interactive requests);
- connector sweep interval `86400000` ms (one sweep per boot/day);
- connector project concurrency `1`;
- connector project timeout `30000` ms;
- database-level `idle_in_transaction_session_timeout = '120s'`:
  `ALTER DATABASE postgres SET idle_in_transaction_session_timeout = '120s';`

Verification: 24 consecutive `POST /v1/access/check-email` calls over 4+ minutes
returned **200 in ~280 ms each**, with no idle-in-transaction buildup.

**The starvation returned.** On 2026-10-20 at 03:39 the same three authenticated
endpoints (`/v1/accounts`, `/v1/user-roles`, `/v1/account-invites`) waited
24.8 s and returned 503 while public endpoints stayed 200
(`db;dur=24828`, `db_pool_wait_suspected: true`). The trigger scheduler had
logged `SCHEDULER STALLED` every second since 01:57:43: a sweep started and
never completed, leaving its postgres.js connection checked out. Notably,
`pg_stat_activity` showed **no active query** - with Supavisor transaction
pooling an idle client holds no server backend, which is the signature of a
**client-side** pool leak rather than a slow query.

Final mitigation (release **v24**, 2026-10-20):

- `KORTIX_TRIGGER_SCHEDULER_ENABLED=false` disables the singleton scheduler
  worker entirely (cron triggers, execution drain, monitor drain, connector
  sweep). It was the only component that leaked connections.
- The dyno restart performed by the config change clears the poisoned pool.

Post-restart verification: 10/10 `check-email` probes returned 200 in
1.0-1.8 s, and calls with a real Supabase access token returned
`/v1/accounts` 200, `/v1/user-roles` 200, `/v1/account-invites` 200.

Trade-off: scheduled cron triggers, monitor event drains, and connector
reconciliation do not run while the flag is false. That is acceptable for this
deployment because connectors are already unusable (invalid Pipedream
credentials). Re-enable only after fixing the leak in
`runProjectTriggerSweep` / `fireGitTrigger`: in-flight work must be aborted
(`AbortSignal`), not merely left running behind a rejected `withTimeout`
promise, and postgres.js needs an acquire timeout so a leaked connection fails
fast instead of producing a 25 s request stall.

---

## 4. Supabase (database + auth)

### 4.1 Connection

`db.<ref>.supabase.co` is IPv6-only, which Heroku cannot reach. Use the IPv4
Supavisor pooler:

```
postgresql://postgres.<supabase-project-ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require
```

The API sets `prepare: false` for pooler compatibility.

### 4.2 Schema migrations

The migration runner is `packages/db/scripts/migrate.ts`:

```sh
bun packages/db/scripts/migrate.ts status
bun packages/db/scripts/migrate.ts up
bun packages/db/scripts/migrate.ts down --count=1
```

Run it from a Heroku one-off dyno (the image contains the runner):

```powershell
heroku run -a dosco --no-tty "cd /app && NODE_TLS_REJECT_UNAUTHORIZED=0 bun packages/db/scripts/migrate.ts status"
heroku run -a dosco --no-tty "cd /app && NODE_TLS_REJECT_UNAUTHORIZED=0 bun packages/db/scripts/migrate.ts up"
```

Notes:

- **Scale web to 0 before migrating** if a migration takes locks:
  `PATCH /apps/dosco/formation/web {"quantity":0}`.
  A running API holds table locks; the RLS migration failed once on
  `lock_timeout` (2 s) against `project_git_connections`.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is needed for the **migration process only**:
  `pg` treats `sslmode=require` as verify-full and the Supavisor chain is not in
  the container trust store. The API itself uses postgres.js and is unaffected.
- Supavisor transaction pooling can keep a backend alive after the client
  disconnects; a failed migration can leave an advisory lock behind. Find and
  terminate it:

  ```sql
  SELECT pid, classid, objid, granted, mode
  FROM pg_locks WHERE locktype = 'advisory';

  SELECT pg_terminate_backend(pid)
  FROM pg_locks
  WHERE locktype = 'advisory'
    AND ((classid::bigint << 32) | objid::bigint) = 7241865325823964;
  ```

- Verify after a run: `status` must print
  `Up to date - no pending migrations.`

### 4.3 Database-level settings

| Setting | Value | Why |
|---|---|---|
| `statement_timeout` | `25s` (database default) | prevents one query pinning a connection forever |
| `idle_in_transaction_session_timeout` | `120s` (added) | kills leaked worker transactions that hold pool slots |

### 4.4 Auth configuration

- Project already contains real users (created Sept-Oct 2026); it is **not** a
  fresh auth project.
- Provider status (from `/auth/v1/settings`): `email: true`, `google: true`,
  everything else off. `mailer_autoconfirm: false` (email sign-ups require
  confirmation).
- **Site URL is `https://dosco.live`.**
- The redirect allowlist accepts `https://dosco.live/...` and (as of
  2026-10-20) `https://dosco-virid.vercel.app/...`. Before the Vercel entry was
  added, callbacks fell back to the Site URL - that was the login failure
  described in section 7. Verified after the change: the callback probe
  redirects to the requested Vercel URL. `http://localhost:3000/**` still needs
  to be added for local development.

Required dashboard settings (Authentication -> URL Configuration):

```
Site URL:       https://dosco.live
Redirect URLs:  https://dosco.live/**
                https://dosco-virid.vercel.app/**
                http://localhost:3000/**
```

### 4.5 Service role key

`SUPABASE_SERVICE_ROLE_KEY` was printed into a one-off dyno command during
bring-up and is therefore exposed to anyone who could read that log stream.
Rotate it in Supabase (Settings -> API -> service_role -> rotate), then update
the Heroku config var in the same step:

```powershell
heroku config:set SUPABASE_SERVICE_ROLE_KEY=<new-key> -a dosco
```

Rotating restarts the dyno. The frontend never uses the service role key.

---

## 5. Vercel (frontend)

### 5.1 Project settings

| Setting | Value |
|---|---|
| Project | `dosco` (`prj_mEKYUFNPOV6wM5BkWY9qe4e7N2pS`) |
| Git repo | `kageprime/dosco-suna` |
| Production branch | `main` |
| Root directory | `apps/web` |
| Framework | Next.js |

### 5.2 Environment variables

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | `https://dosco-05dd0b153705.herokuapp.com/v1` | API base |
| `NEXT_PUBLIC_APP_URL` | `https://dosco-virid.vercel.app` | change to `https://dosco.live` once DNS is live |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<supabase-project-ref>.supabase.co` | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon JWT | public by design |
| `NEXT_PUBLIC_AUTH_PROVIDERS` | `google` | **added 2026-10-20**; controls the Google button |
| `NEXT_PUBLIC_AUTH_METHODS` | *(unset)* | code default `magic,password` |
| `NEXT_PUBLIC_BILLING_ENABLED` | boolean | |
| `NEXT_PUBLIC_WEBHOOK_BASE_URL` | public base for webhooks | |
| `KORTIX_TURBOPACK_EVICTION` | `full` | avoids build OOM / turbopack cache eviction |

`NEXT_PUBLIC_*` values are **inlined at build time**. Changing one requires a
new deployment, not just a restart.

The auth page renders social providers only from `NEXT_PUBLIC_AUTH_PROVIDERS`:

```tsx
const enabledProviders = (getEnv().AUTH_PROVIDERS || '').split(',')...
const googleEnabled = enabledProviders.includes('google');
```

### 5.3 Deploying

- Push to `main` (Vercel auto-builds), or create a deployment explicitly:

  ```http
  POST https://api.vercel.com/v13/deployments
  {
    "name": "dosco",
    "project": "prj_mEKYUFNPOV6wM5BkWY9qe4e7N2pS",
    "target": "production",
    "gitSource": { "type": "github", "repoId": 1281571298, "ref": "main" }
  }
  ```

- Production aliases: `dosco-virid.vercel.app`,
  `dosco-scme19.vercel.app`, `dosco-git-main-scme19.vercel.app`.

---

## 6. Custom domain: dosco.live

The domain is attached to the Vercel project but **not verified**.

Public DNS, verified 2026-10-20 from 1.1.1.1 and 8.8.8.8:

- `A dosco.live` -> `216.198.79.1`, `64.29.17.1` (Vercel) - **live**
- `TXT _vercel.dosco.live` -> **NXDOMAIN**. The required value exists at the
  doubled name `_vercel.dosco.live.dosco.live`.

Required records at the registrar:

| Type | Name (host) | Value |
|---|---|---|
| `TXT` | `_vercel` | `vc-domain-verify=dosco.live,6c1362a3c4869fe4a4aa` |
| `A` | `@` | `216.198.79.1` |
| `A` | `@` | `64.29.17.1` |
| `CNAME` | `www` | `dosco.live` (added 2026-10-23, TTL 300; Vercel verified it and serves the 301 → apex, functionally verified the same day) |

The TXT record must be **renamed, not recreated**: keep the value and change
the host from `_vercel.dosco.live.dosco.live` to `_vercel`. The registrar
appends the zone, so the resulting FQDN is `_vercel.dosco.live`.

Then wait for Vercel to verify (Domains -> dosco.live) and update
`NEXT_PUBLIC_APP_URL` to `https://dosco.live`, followed by a redeploy.
`NEXT_PUBLIC_*` values are inlined at build time, so a new deployment is
required.

`dosco.live` is also `FRONTEND_URL` and the Supabase Site URL, so fixing DNS
makes every auth redirect land on a working origin.

### 6.1 Wildcard domains for Apps and previews

Two wildcard domains are product surfaces, not marketing aliases:

| Surface | Public host | Heroku domain | DNS |
|---|---|---|---|
| Apps | `prod-<slug>-<route-key>.apps.dosco.live` | `*.apps.dosco.live` | CNAME `*.apps` → `structural-shore-qk0rvv6ze40z08csve4z2tos.herokudns.com` |
| Previews | `prod-p<port>-<sandbox-label>.preview.dosco.live` | `*.preview.dosco.live` | CNAME `*.preview` → `general-springs-2pos51cqi60ejh9byk8tttv1.herokudns.com` |

Both are on the Heroku Common Runtime, which supports wildcard custom domains
and ACM wildcard certificates. ACM issued a Let's Encrypt certificate for each
wildcard on 2026-10-23 (valid to 2027-01-21). The wildcard DNS records were
removed from the Vercel project the same day; Vercel no longer serves them.

Release **v62** sets:

```text
KORTIX_APPS_BASE_DOMAIN=apps.dosco.live
KORTIX_PREVIEW_BASE_DOMAIN=preview.dosco.live
KORTIX_APPS_ALLOW_DIRECT_EDGE=true
KORTIX_PREVIEW_ALLOW_DIRECT_EDGE=true
```

`KORTIX_APPS_BASE_DOMAIN` was previously derived from `KORTIX_URL`; setting it
explicitly pins the host. `KORTIX_PREVIEW_BASE_DOMAIN` was unset, so previews
were path-based on `api.dosco.live/v1/p/...`; they are now host-based.

**Trust model.** There is no Cloudflare Worker in front of these domains. The
Heroku wildcard router is the trust boundary; the API reads the real `Host`
because `KORTIX_APPS_ALLOW_DIRECT_EDGE` and `KORTIX_PREVIEW_ALLOW_DIRECT_EDGE`
are `true`. App viewer gates and preview auth still enforce access. The tradeoff
is no edge signature and no Cloudflare edge cache: every App and preview
request reaches the Heroku dyno. Add the Cloudflare Workers only if the edge
cache or the HMAC signature is required.

Verify:

```bash
heroku domains -a dosco
heroku certs:auto -a dosco
curl -sS -i https://prod-<slug>-<route-key>.apps.dosco.live/
curl -sS -i https://prod-p<port>-<sandbox-label>.preview.dosco.live/
```

A valid-shape App host that does not exist returns
`{"error":"App not found"}` from the App handler. A preview host without a
session returns `401 {"error":"Unauthorized"}` from the preview gate. Both
responses carry `Server: Heroku`; a Vercel marketing page means DNS or the
Vercel domain attachment is still wrong.

Rollback:

1. `heroku config:unset KORTIX_APPS_BASE_DOMAIN KORTIX_PREVIEW_BASE_DOMAIN KORTIX_APPS_ALLOW_DIRECT_EDGE KORTIX_PREVIEW_ALLOW_DIRECT_EDGE -a dosco`
2. `heroku domains:remove '*.apps.dosco.live' '*.preview.dosco.live' -a dosco`
3. Re-add the wildcards to the Vercel project.
4. Restore the Name.com wildcard `A` records to `64.29.17.65` and `216.198.79.65`.

---

## 7. Authentication: how it works and why login failed

### 7.1 Flows

- **Email magic link**: the auth page posts to `/api/auth/send-code`, which calls
  Supabase `signInWithOtp` with `emailRedirectTo = <origin>/auth/callback`.
- **Password**: `/api/auth/password?intent=signin|signup` calls
  `signInWithPassword` / `signUpWithPassword`.
- **Google**: lazily loaded `features/auth/google-signin.tsx` calls
  `supabase.auth.signInWithOAuth({ provider: 'google', redirectTo: <callback> })`.
  It renders only when `NEXT_PUBLIC_AUTH_PROVIDERS` contains `google`.
- **SAML/SSO**: optional, probed only when the Supabase instance enables SAML.

### 7.2 Why login failed (2026-10-20)

Two independent issues:

1. **Redirect allowlist / Site URL mismatch.**
   Supabase's Site URL is `https://dosco.live`; the allowlist only matches that
   host. The frontend runs on `https://dosco-virid.vercel.app`, so Supabase
   silently replaces the requested `redirect_to` with the Site URL:

   ```
   GET /auth/v1/verify?token=bogus&type=magiclink
       &redirect_to=https://dosco-virid.vercel.app/auth/callback

   303 Location: https://dosco.live#error=access_denied&error_code=otp_expired...
   ```

   With a valid link the same rewrite happens, so the browser goes to
   `dosco.live` - which is attached to Vercel but not yet verified, so no
   certificate is issued and HTTPS fails.

2. **Google button hidden.**
   Vercel had no `NEXT_PUBLIC_AUTH_PROVIDERS`, so `googleEnabled` was false.
   Meanwhile the owner account is a **Google-only** account (provider
   `google`, confirmed) with no password. Trying email/password on it returns
   "invalid login credentials". Google OAuth itself is configured and working
   (the authorize endpoint 302s to Google with client id
   `598338179937-...apps.googleusercontent.com`).

### 7.3 Fix checklist

- [x] Add `NEXT_PUBLIC_AUTH_PROVIDERS=google` to Vercel and redeploy.
- [x] Add the Vercel URL to Supabase Redirect URLs (section 4.4) - verified
      2026-10-20: the callback probe now redirects to
      `https://dosco-virid.vercel.app/auth/callback`.
- [ ] Add `http://localhost:3000/**` for local development.
- [x] Point the `dosco.live` A records at Vercel (section 6).
- [ ] Rename the `_vercel` TXT record so Vercel can verify the domain and
      issue the certificate.
- [ ] Sign in with **Continue with Google** for Google-only accounts; use
      "Forgot password" to give an email account a password.
- [ ] Optionally disable email confirmation or configure custom SMTP
      (`mailer_autoconfirm: false` today; Supabase's default mailer is rate
      limited and not intended for production volume).

### 7.4 Verifying the allowlist from the CLI

```sh
curl -i "https://<supabase-project-ref>.supabase.co/auth/v1/verify?token=bogus&type=magiclink&redirect_to=https%3A%2F%2Fdosco-virid.vercel.app%2Fauth%2Fcallback"
```

The `Location` header must start with the requested URL. If it points at
`https://dosco.live`, the URL is not allowlisted.

---

## 8. Incident log (chronological)

1. **Container never started.**
   Every dyno died 12-18 s after `State changed ... starting`, with no stdout and
   no `Starting process with command`. A minimal image proved the platform was
   healthy. Root cause: image layer count (88 -> 61) above the Common Runtime's
   40-layer guidance. Fixed by consolidating to 14 layers.

2. **Boot `ENOENT` for `apps/kortix-app-runtime/main.go`.**
   `runtime-artifacts.ts` hashes Go sources at module evaluation. Added the
   source tree to the builder; the runner inherits it through the consolidated
   `apps` copy.

3. **Schema drift after boot.**
   Workers logged `column "source" does not exist`. Migrations had never been
   applied to this Supabase project. Ran `migrate.ts up`; the RLS migration
   first failed on a 2 s `lock_timeout` because the API was running. Scaled web
   to 0, retried, then hit a lingering Supavisor advisory lock; terminated the
   backend holding it and completed the run.

4. **`SELF_SIGNED_CERT_IN_CHAIN` in migrations.**
   `pg` (node-pg-migrate) verifies `sslmode=require`, unlike the API's client.
   Used `NODE_TLS_REJECT_UNAUTHORIZED=0` for the one-off migration process only.

5. **Pool starvation (503 request deadline).**
   Background trigger/connector workers pinned all six postgres.js connections;
   postgres.js queues forever. Added `DB_POOL_MAX=10`, paused/throttled the
   connector sweep, and set `idle_in_transaction_session_timeout=120s`. Verified
   24/24 requests at ~280 ms over 4+ minutes.

6. **Vercel build memory.**
   Turbopack cache eviction caused build failures; fixed with
   `KORTIX_TURBOPACK_EVICTION=full`.

7. **Login failure.**
   Supabase Site URL/allowlist only covers `dosco.live`, which is not pointed at
   the app yet; the Google button was hidden by a missing Vercel env var.
   Addressed by `NEXT_PUBLIC_AUTH_PROVIDERS=google` + the checklist in 7.3.

8. **Pool starvation recurrence -> scheduler disabled.**
   After the first mitigations, authenticated endpoints 503'd again at 03:39
   (24.8 s waits) while public endpoints stayed healthy. Root cause: the
   trigger scheduler's sweep had been stuck since 01:57 and held a checked-out
   postgres.js connection that never returned to the pool. Restarting the dyno
   cleared it; `KORTIX_TRIGGER_SCHEDULER_ENABLED=false` (v24) prevents it from
   recurring. Re-enable only with an abortable sweep and an acquire timeout.

---

## 9. Runbook

### 9.1 Deploy the API (Heroku)

```powershell
cd C:\Users\kage\Desktop\dosco-suna
git status                       # must be on heroku-clean
git add -A
git commit -m "Deploy: <description>"
git push "https://heroku:$HEROKU_TOKEN@git.heroku.com/dosco.git" HEAD:main --force
heroku releases -a dosco -n 3
heroku logs -a dosco -n 100
```

### 9.2 Deploy the frontend (Vercel)

```powershell
# normal path: push to main
git push origin main

# or trigger a deployment from the API (same commit)
curl -X POST https://api.vercel.com/v13/deployments \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"dosco","project":"prj_mEKYUFNPOV6wM5BkWY9qe4e7N2pS","target":"production","gitSource":{"type":"github","repoId":1281571298,"ref":"main"}}'
```

### 9.3 Health and smoke checks

```powershell
curl.exe -s -o NUL -w "health=%{http_code}`n" https://dosco-05dd0b153705.herokuapp.com/health
curl.exe -s -o NUL -w "ready=%{http_code}`n"  https://dosco-05dd0b153705.herokuapp.com/health/ready
curl.exe -s -o NUL -w "market=%{http_code}`n" https://dosco-05dd0b153705.herokuapp.com/v1/marketplace/marketplaces
curl.exe -s -o NUL -w "web=%{http_code}`n"    https://dosco-virid.vercel.app/
```

### 9.4 Restart a dyno

```powershell
$tok = Get-Content $env:TEMP\heroku-token.txt
curl.exe -X DELETE -H "Authorization: Bearer $tok" `
  -H "Accept: application/vnd.heroku+json; version=3" `
  https://api.heroku.com/apps/dosco/dynos/web.1
```

### 9.5 Inspect sessions / locks

```sql
SELECT pid, usename, application_name, state,
       now() - xact_start AS xact_age, left(query, 100)
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY xact_start;

SELECT pid, mode, granted, relation::regclass
FROM pg_locks
WHERE NOT granted;
```

### 9.6 Common errors

| Symptom | Cause | Action |
|---|---|---|
| Dyno crashes ~15 s, no stdout | image > 40 layers | consolidate layers; check manifest |
| `Request exceeded the 25s server processing deadline` + `db_pool_wait_suspected` | pool starvation (client-side leak) | restart the dyno to clear it; set `KORTIX_TRIGGER_SCHEDULER_ENABLED=false`; fix/abort the leaked sweep before re-enabling |
| `SELF_SIGNED_CERT_IN_CHAIN` in one-off dyno | `pg` + Supavisor chain | run migration with `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| Auth callback lands on `dosco.live` | redirect URL not allowlisted | add it in Supabase -> URL Configuration |
| No Google button | `NEXT_PUBLIC_AUTH_PROVIDERS` missing | set env + redeploy |
| Frontend build fails | turbopack memory | `KORTIX_TURBOPACK_EVICTION=full` |
| `Pipedream auth failed (401)` | invalid Pipedream creds | set valid creds or leave connectors disabled |

---

## 10. Security and outstanding work

- [ ] **Rotate `SUPABASE_SERVICE_ROLE_KEY`** (exposed in a one-off dyno command).
- [ ] Add Supabase redirect URLs for the Vercel and localhost origins.
- [ ] Rename the `_vercel` TXT record, verify `dosco.live` in Vercel, switch
      `NEXT_PUBLIC_APP_URL` to `https://dosco.live`.
- [ ] Rotate/remove the temporary Heroku and Vercel tokens under
      `C:\Users\kage\AppData\Local\Temp\opencode\` when finished.
- [ ] Configure valid Pipedream credentials if connectors are needed.
- [ ] Optional cleanup: Supabase `bootlogs` bucket test files, minimal-probe
      directories.
- [ ] Consider a code-level fix for abandoned connector sweeps
      (`AbortSignal` + acquire timeout) rather than the env throttle.
- [ ] `KORTIX_VERSION` / `KORTIX_COMMIT` are not passed to the Heroku build, so
      `/health` reports `dev` / `unknown`; wire build args if that matters.

---

## 11. Current status (2026-10-24)

| Component | Status |
|---|---|
| Heroku API | up, Standard-2X (release **v68** `Deploy 7ef32993`, live 2026-10-24 11:31Z, `/health` 200; v68 makes the v67 redirect follower trust the dialled ingress domain (`*.e2b.app`) — v67 checked `E2B_DOMAIN=e2b.dev` only and handed every E2B Cloud hop to the browser; v67 replaced v65's app-host Location rewrite with the server-side follower; v64 enabled the tunnel + set `TUNNEL_SIGNING_SECRET`, rotated at v66; v63 adds the E2B provider-handle invalidation; v62 added the wildcard config vars and runs the same 32-instruction image as v61; v61 is the unified tree; v37 shipped the xera starter fix + the first E2B preview fix) |
| Backend domain | **`https://api.dosco.live`** — Heroku custom domain + ACM (Let's Encrypt, renews 2026-12-21), `KORTIX_URL=https://api.dosco.live` (v61), frontend `NEXT_PUBLIC_BACKEND_URL` pointed at `https://api.dosco.live/v1` (prod+preview; `development` keeps the herokuapp value), web redeployed 2026-10-23. The raw `dosco-05dd0b153705.herokuapp.com` keeps serving for everything (sandboxes, CLIs, connector callbacks already registered against it). |
| `/health`, `/health/ready` | 200 on both `api.dosco.live` and the herokuapp origin |
| Starter and blank-project default agent | `agents/xera.md`, `default_agent: xera`; verified inside the release v26 image. The OpenCode config must agree: `harnesses/opencode/opencode.jsonc` `"default_agent": "xera"` — it briefly shipped `kortix` (left over from the reskin), so every seeded release failed its proven check with `the default agent "kortix" is not loaded`; fixed 2026-10-23. |
| Authenticated API (`/v1/accounts`, `/v1/user-roles`, `/v1/account-invites`) | 200 with a real Supabase token |
| DB migrations | up to date |
| Marketplace / access endpoints | 200 |
| Vercel frontend | live at `dosco-virid.vercel.app`; production deploys built from the manual `vercel-redeploy.mjs` flow (prod auto-deploy disabled) |
| Google provider (Supabase) | enabled, redirects to Google |
| Google button (frontend) | enabled via `NEXT_PUBLIC_AUTH_PROVIDERS=google`; verified in the deployed `/auth` HTML on 2026-10-20 |
| Supabase redirect allowlist | Vercel callback accepted (verified 2026-10-20); localhost still to add |
| `dosco.live` DNS (Name.com) | apex `64.29.17.1` + `216.198.79.1` (Vercel's current anycast pair; verified via `_vercel` TXT 2026-10-20); `api` CNAME → `fluffy-parsnip-mgd3ejvtvyyvydkhbor18vwb.herokudns.com` (2026-10-23); `www` CNAME → `dosco.live` (2026-10-23, verified, 301 → apex — checked: `https://www.dosco.live/` → 301 → 200 at apex, TLS clean); `status` → betteruptime; SES mail records intact (`send` SPF, `resend._domainkey` DKIM, `_dmarc`, inbound MX). `*.apps` CNAME → `structural-shore-qk0rvv6ze40z08csve4z2tos.herokudns.com`; `*.preview` CNAME → `general-springs-2pos51cqi60ejh9byk8tttv1.herokudns.com` (both added 2026-10-23; removed from Vercel the same day). Heroku ACM issued `*.apps.dosco.live` and `*.preview.dosco.live` (Let's Encrypt, valid to 2027-01-21). Release **v62** sets `KORTIX_APPS_BASE_DOMAIN=apps.dosco.live`, `KORTIX_PREVIEW_BASE_DOMAIN=preview.dosco.live`, `KORTIX_APPS_ALLOW_DIRECT_EDGE=true`, `KORTIX_PREVIEW_ALLOW_DIRECT_EDGE=true`; Apps and previews are host-routed through Heroku with no Cloudflare Worker. See §6.1. |
| GitHub App callbacks | minted from `KORTIX_URL` → now `api.dosco.live`; the App's registered callback list must include `https://api.dosco.live/v1/platform/github-app/oauth/callback` (old hosts keep working) — **pending in GitHub settings** |
| Service role key rotation | **pending** |
| Pipedream credentials | invalid (401) - connectors disabled with the scheduler |
| TUNNEL_ENABLED | true (set at v64). `GET /v1/tunnel/connections` answers 401 unauthenticated (verified 2026-10-24; it was 503 `tunnel_disabled` before). `TUNNEL_SIGNING_SECRET` was set at v64 and **rotated at v66** after `releases:info` printed a config readout — never run an unfiltered `releases:info`; read one var with `heroku config:get <VAR>` and never print its value. |

## 12. Known incidents and fixes (2026-10-23)

- **The unified-tree image crashed silently, then booted with two COPY
  defects.** Releases v39-v55 ran origin's `apps/api/Dockerfile` verbatim
  (75 final-stage instructions); the Common Runtime refused to start the image
  (no `Starting process` line, no stdout, `crashed` 2-18 s). The consolidated
  `Dockerfile.heroku` (32 instructions) boots, and exposed two merged-`COPY`
  flattenings: `agent-tunnel/src` (boot exit 1 with `Cannot find package
  'agent-tunnel'`) and three fingerprint trees (startup pre-build `ENOENT ...
  lstat`). Release v61 is the fixed image. Proof: `web.1 up`, `/health` 200,
  `/health/ready` 200, CORS preflight 204, startup pre-build `ready`.
- **Meta image pre-build fails on E2B (pre-existing, open).** The startup
  pre-build logs `Invalid source path "/workspace/AGENTS.md": absolute paths
  are not allowed` for the meta image, while the default image reports
  `ready`. The path comes from the heredoc `COPY ... /workspace/AGENTS.md` in
  `packages/shared/src/sandbox/meta-dockerfile.ts` (introduced in
  `bc13c87e00`). The old branch carries the same file, so this is not a
  regression from the unified tree. The error text does not exist in the repo,
  so it comes from the E2B SDK's build-context upload. Project sessions use
  the default image and are unaffected. Fix: handle the heredoc in the E2B
  context builder, or write the file with a `RUN` step.
- **Sandbox previews and App previews on E2B broke after a resume** ("Missing
  traffic access token. The e2b-traffic-access-token header is missing",
  against the served sandbox id). E2B mints a NEW traffic token on every
  pause-resume. The first fix (2026-10-23) recognized E2B's 403 refusals and
  dropped the per-port preview link cache, but E2B disables that cache
  (`ingressCacheTtlMs = 0`). The stale token lived in the provider's 5 s
  `connectedSandboxes` handle, so the retry re-resolved the same token. The App
  public proxy (`*.apps.dosco.live`) also passed the 403 through because its
  recovery handled only 400/5xx. Release **v63** adds
  `SandboxProvider.invalidateIngress?`; `E2BProvider` drops the connected handle
  and the running-status cache. The sandbox proxy and the App public proxy call
  it before their single retry; the App proxy replays only a GET/HEAD. The raw
  `*.e2b.app` URL remains provider-owned and still needs the header; use the
  Dosco App host or `*.preview.dosco.live`.
- **The first redirect fix (v65) redirected the App host into an
  `ERR_TOO_MANY_REDIRECTS` loop.** E2B canonicalizes an app across its own host
  family: a request on the port-ingress host is bounced (308/302, sometimes a
  303 after a login form) to the bare sandbox host, or re-schemed. Given such a
  Location the browser loses the token header and faces the provider's 403
  page; v65 therefore rewrote the Location onto the App host — which loops
  against any app whose middleware bounces every path back onto the upstream
  host: rewrite and app answer each other forever. Release **v67** replaces the
  rewrite with a bounded server-side follow (`provider-redirect-follow.ts`):
  GET/HEAD only, max 3 hops, only provider-owned hosts, the ingress credential
  headers re-attached on every hop, a write redirect passed through untouched,
  and a fruitless chain answered with a visible `502 sandbox_redirect_loop`
  instead of a Location the browser spins on. `sanitizeRedirectLocation` is
  back to self/external Locations only.
- **v67's follower never followed an E2B Cloud hop (fixed in v68).** It
  trusted only hosts under `E2B_DOMAIN`, which is `e2b.dev` on this app (the
  API domain). Sandbox ingress is served on `*.e2b.app`, so every
  canonical-host 308 reached the browser, which then hit E2B's "Missing traffic
  access token" page. Symptom in `heroku logs`: `GET /v1/p/<sandbox_id>/<port>
  308` from the API. Release **v68** trusts the parent domain of the ingress
  host just dialled (`<port>-<sandbox_id>.<domain>`; a one-label parent is
  never trusted) plus `E2B_DOMAIN`. Do not set `E2B_DOMAIN=e2b.app` as a
  workaround: the same value configures the E2B SDK and the templates API.
