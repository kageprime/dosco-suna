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
| `kageprime/dosco-suna` `main` | Full source (backend + `apps/web`) | Vercel |
| `heroku-clean` (orphan) | Backend-only tree, no `apps/web` | Heroku (pushed to Heroku `main`) |

Rules:

- Vercel builds **only** from `main`, with **Root Directory = `apps/web`**.
- Heroku is pushed from `heroku-clean` only:
  `git push https://heroku:$HEROKU_TOKEN@git.heroku.com/dosco.git HEAD:main --force`
- **Never push `heroku-clean` to `origin/main`.** It is an orphan backend-only
  branch and would replace the frontend source.
- Heroku builds `Dockerfile.heroku` via `heroku.yml`; the root `Dockerfile` is
  kept for self-hosted/full deployments.

Local working copies:

- `C:\Users\kage\Desktop\dosco-suna` - backend worktree (currently on
  `heroku-clean`).
- `C:\Users\kage\Desktop\dosco-web` - full frontend source tree used for
  frontend changes.

---

## 3. Heroku (API)

### 3.1 Runtime shape

- Stack: `container`, generation `cedar`.
- `heroku.yml`:

  ```yaml
  build:
    docker:
      web: Dockerfile.heroku
  run:
    web: /app/apps/api/start.sh
  ```

- `apps/api/start.sh` ends with `exec bun run src/serve.ts`. `serve.ts` binds
  `$PORT` immediately and evaluates the app behind the listener, so the platform
  sees the port open before the route graph finishes loading.

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

Fix: `Dockerfile.heroku` now produces a **14-layer** image (verified from the
registry manifest):

- all `pnpm install` work and every file fixup happens in the `deps` stage;
- the runner copies three consolidated trees:
  `node_modules`, `packages`, and `apps`;
- the agent-tunnel workaround and test-file pruning also happen in `deps`;
- only `ca-certificates`, `curl`, and `git` are installed at runtime.

Do not introduce new `COPY`/`RUN` instructions in the runner stage without
counting layers. Keep the final image comfortably under 40 layers (aim < 20).

### 3.3 What the image contains

Included:

- Bun 1.4.3 slim base;
- `node_modules` and workspace `packages/*` (including DB migrations and
  starter templates);
- `apps/api`;
- `apps/kortix-sandbox-agent-server` and `apps/cli` **source** (runtime
  fingerprints read them);
- `apps/kortix-app-runtime` Go **source** files. `apps/api/src/apps/runtime-artifacts.ts`
  hashes `main.go` and the caddy sources at boot; omitting them caused an
  `ENOENT ... /app/apps/kortix-app-runtime/main.go` at module evaluation.

Deliberately excluded:

- compiled Go binaries (`kortix-appd`, `caddy`);
- compiled sandbox agent/CLI binaries;
- `docker.io`;
- `apps/sandbox` assets.

Consequence: Daytona snapshot builds that need the compiled binaries would fail
inside this image. The deployment uses **E2B**, so this is intentional. If
Daytona is enabled later, build and ship those artifacts (and re-check layers).

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
| `CNAME` | `www` | `cname.vercel-dns.com` (optional, if `www` is wanted) |

The TXT record must be **renamed, not recreated**: keep the value and change
the host from `_vercel.dosco.live.dosco.live` to `_vercel`. The registrar
appends the zone, so the resulting FQDN is `_vercel.dosco.live`.

Then wait for Vercel to verify (Domains -> dosco.live) and update
`NEXT_PUBLIC_APP_URL` to `https://dosco.live`, followed by a redeploy.
`NEXT_PUBLIC_*` values are inlined at build time, so a new deployment is
required.

`dosco.live` is also `FRONTEND_URL` and the Supabase Site URL, so fixing DNS
makes every auth redirect land on a working origin.

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

## 11. Current status (2026-10-20)

| Component | Status |
|---|---|
| Heroku API | up, Standard-2X (release v38 at the 2026-10-23 verification; v37 shipped the xera starter fix + the E2B preview fix) |
| Backend domain | **`https://api.dosco.live`** — Heroku custom domain + ACM (Let's Encrypt, renews 2026-12-21), `KORTIX_URL=https://api.dosco.live` (v38), frontend `NEXT_PUBLIC_BACKEND_URL` pointed at `https://api.dosco.live/v1` (prod+preview; `development` keeps the herokuapp value), web redeployed 2026-10-23. The raw `dosco-05dd0b153705.herokuapp.com` keeps serving for everything (sandboxes, CLIs, connector callbacks already registered against it). |
| `/health`, `/health/ready` | 200 on both `api.dosco.live` and the herokuapp origin |
| Starter and blank-project default agent | `agents/xera.md`, `default_agent: xera`; verified inside the release v26 image. The OpenCode config must agree: `harnesses/opencode/opencode.jsonc` `"default_agent": "xera"` — it briefly shipped `kortix` (left over from the reskin), so every seeded release failed its proven check with `the default agent "kortix" is not loaded`; fixed 2026-10-23. |
| Authenticated API (`/v1/accounts`, `/v1/user-roles`, `/v1/account-invites`) | 200 with a real Supabase token |
| DB migrations | up to date |
| Marketplace / access endpoints | 200 |
| Vercel frontend | live at `dosco-virid.vercel.app`; production deploys built from the manual `vercel-redeploy.mjs` flow (prod auto-deploy disabled) |
| Google provider (Supabase) | enabled, redirects to Google |
| Google button (frontend) | enabled via `NEXT_PUBLIC_AUTH_PROVIDERS=google`; verified in the deployed `/auth` HTML on 2026-10-20 |
| Supabase redirect allowlist | Vercel callback accepted (verified 2026-10-20); localhost still to add |
| `dosco.live` DNS (Name.com) | apex `64.29.17.1` (Vercel, verified via `_vercel` TXT 2026-10-20); `api` CNAME → `fluffy-parsnip-mgd3ejvtvyyvydkhbor18vwb.herokudns.com` (2026-10-23); `status` → betteruptime; SES mail records intact (`send` SPF, `resend._domainkey` DKIM, `_dmarc`, inbound MX). `www` has NO record after the 216.198.79.1 cleanup — add `CNAME www → dosco.live`; `*.apps` / `*.preview` wildcards still point at raw Vercel IPs that serve nothing (dead leftovers, safe to delete or repurpose when a wildcard story lands). `www.dosco.live` is attached to the Vercel project as a 301 → apex pending that record. |
| GitHub App callbacks | minted from `KORTIX_URL` → now `api.dosco.live`; the App's registered callback list must include `https://api.dosco.live/v1/platform/github-app/oauth/callback` (old hosts keep working) — **pending in GitHub settings** |
| Service role key rotation | **pending** |
| Pipedream credentials | invalid (401) - connectors disabled with the scheduler |
| TUNNEL_ENABLED | false - "Computers" routes return 503 `tunnel_disabled` by design |

## 12. Known incidents and fixes (2026-10-23)

- **Sandbox previews on E2B broke after a resume** ("Missing traffic access
  token. The e2b-traffic-access-token header is missing", for example sandbox
  `iskbwr82f9wc2k0srkdv1`). E2B mints a NEW traffic token on every
  pause-resume; the preview proxy's per-port link cache kept serving the
  pre-restart token for up to its 5-minute TTL, and the cached-token refusal
  refresh path (`provider-auth.ts` / sandbox-proxy `retry.ts`) covered Daytona
  only. Fixed by recognizing E2B's 403 traffic-token refusals (JSON or HTML,
  both name the header) in `isProviderIngressAuthFailure` — the same
  invalidate-and-retry-once healing — and by dropping ALL of a sandbox's cached
  preview links at the restart boundary in `wakeSandbox`. Deploy requires an
  apps/api release.
