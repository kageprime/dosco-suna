# Project analysis: what the factory needs to know

The setup agent runs this once, before it writes `factory.json`, on the
person's own checkout. Read; never run the app against production; never
`cat` an env file. The output is `factory.json` plus a short report to the
person. Every row below is checked; a row that does not apply is written as
`none found` in the report.

## 1. Layout and toolchain

| Check | How | Feeds |
|---|---|---|
| Monorepo or single app; the apps and packages | `pnpm-workspace.yaml`, `package.json` `workspaces`, `turbo.json`, `nx.json`, `lerna.json`, `go.work`, Cargo `[workspace]`, top-level folders | `sources.codebase-analysis.units` |
| Languages and versions | `.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, `engines`, `pyproject.toml`, `go.mod`, `rust-toolchain.toml`, `Gemfile` | the sandbox Dockerfile (generic guide step 5) |
| Package managers and lockfiles | the lockfile names | `sources.dependencies` |
| Services | `docker-compose*.yml`, `compose*.yaml`, `supabase/config.toml`, `prisma/schema.prisma`, `drizzle.config.*`, `.devcontainer/` | `container_runtime`, the dev-environment skill |
| Dev, build, type check, lint, unit test and end-to-end commands | `package.json` scripts, `Makefile`, `justfile`, `Taskfile.yml`, `tox.ini`, `noxfile.py`, the README's development section, `playwright.config.*`, `cypress.config.*` | the dev-environment skill; `sources.tests.command` |
| The trunk and branch rules | `gh api repos/<repo> --jq .default_branch`; `gh api repos/<repo>/branches/<trunk>/protection` (required checks, required reviews; `404` = none) | `repository.trunk`; `merge` (required reviews mean a person merges anyway: `hold`) |
| CI | `.github/workflows/*.yml`: which run on `pull_request`, which are required | merge gate G4 |
| Deploy targets | `vercel.json`, `netlify.toml`, `fly.toml`, `render.yaml`, a `Dockerfile` with a deploy workflow, `serverless.yml`, Terraform, Helm | the follow-up check (contract §14); never a factory write |
| Pull request conventions | `.github/pull_request_template.md`, `CONTRIBUTING.md`, the commit style of `git log --oneline -30` | worker step 5 |
| Code owners | `CODEOWNERS` (`.github/`, the root, `docs/`) | `merge.hold_paths` for paths a named team owns |

## 2. Where tickets live today

| Signal | How |
|---|---|
| GitHub Issues in use | `gh issue list -R <repo> --state all --limit 50 --json createdAt,labels`: issues in the last 90 days, the labels in use |
| Linear | `linear.app` links in the README, the PR template or recent PR bodies (`gh pr list --state merged --limit 30 --json body`), branch names like `eng-123-…`, a `linear` connector in the workspace (`kortix connectors ls`) |
| Jira | `atlassian.net/browse/` links, branch names like `PROJ-123`, a `jira` connector |
| Asana | `app.asana.com` links, an `asana` connector |
| None | few issues, no tracker links |

**Ask** the person which store is the source of truth. Recommend the one in
use. None in use: GitHub Issues on the repository (a private repository) or
`json-file` (the person wants nothing visible on GitHub). A public
repository: GitHub Issues works for bugs and features, but security findings
need a private store (`sources/security.md`, rule 6).

## 3. Signals the factory can read

Recommend a source only when its evidence is in the repository or the
workspace. Each row names the evidence, the source to recommend and what it
needs (names only).

| Evidence in the repository or the workspace | Source | Needs |
|---|---|---|
| `@sentry/*`, `sentry-sdk`, `sentry_sdk`, `sentry.*.config.*`, a `SENTRY_DSN` name in `.env.example` | `errors`, tracker `sentry`, delivery `poll` | `SENTRY_AUTH_TOKEN` (`event:read`, `project:read`) + `SENTRY_ORG` |
| `@logtail/*`, `@betterstack/*`, `logtail`, a Better Stack DSN | `errors`, tracker `betterstack`, delivery `poll`; `logs-anomaly` when logs go there | `BETTERSTACK_API_TOKEN`; `CLICKHOUSE_URL` (Telemetry, read-only) |
| `rollbar`, `@bugsnag/*`, `honeybadger`, `dd-trace`, `@datadog/*`, `@highlight-run/*`, `posthog` | `errors`, tracker `generic`, delivery `push` | the tracker's webhook with `FACTORY_ERRORS_WEBHOOK_SECRET` |
| ClickHouse clients (`@clickhouse/client`), Loki, CloudWatch, Datadog logs, Elastic | `logs-anomaly` | a read-only logs credential |
| Postgres: `pg`, `postgres`, `psycopg`, `prisma` with `postgresql`, `drizzle-orm/pg-core`, a `DATABASE_URL` name, `migrations/` with SQL | `db-observer`, backend `postgres` | `FACTORY_DB_READONLY_URL` (the role in `sources/db-observer.md`) |
| `supabase/config.toml`, `@supabase/supabase-js`, `supabase` in `.env.example` | `db-observer`, backend `supabase` | `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` |
| an end-to-end config (`playwright`, `cypress`, `e2e/`, `tests/e2e`) | `tests` | the dev environment's own secrets |
| Slack connected (`kortix channels status`); a bug or support channel named in the README or CONTRIBUTING | `slack` | the channel names; the bot in each channel |
| an Intercom, Zendesk or Plain widget or SDK; a support email in the README; a mobile app (`ios/`, `android/`, `app.json`, `pubspec.yaml`); a feedback form | `customer-feedback` | the channel's read credential (`sources/customer-feedback.md`) |
| any lockfile | `dependencies` | none beyond `FACTORY_GITHUB_TOKEN` |
| any app with routes or authentication | `security` | none for localhost; `SECURITY_TEST_*` only for a deployed target a person owns |
| any repository over ~5,000 lines | `codebase-analysis` | none |

## 4. Existing agents and rules

Read `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md`,
`.claude/agents/`, `.claude/skills/`, `.agents/skills/` and `CONTRIBUTING.md`.
The worker obeys them (worker step 1.3). Note every rule that conflicts with the
contract (for example "a person opens every pull request") and ask the person
which one wins.

## 5. Risks

| Risk | Check | Do |
|---|---|---|
| Production credentials reaching agents | env files with `PROD`, `LIVE`, `sk_live`, production hosts or production database URLs (names only: `kortix env push --from <file> --names --json`) | never approve them for the factory; the dev environment uses local or test values |
| A public repository | `gh repo view --json visibility` | `sources.github-issues.accept: label`; security findings in a private store; no customer data anywhere |
| Migrations | a migrations folder | add it to `merge.hold_paths` |
| Infrastructure as code | `terraform/`, `infra/`, `helm/`, `k8s/`, `.github/workflows/` | add them to `merge.hold_paths` |
| A public API or SDK | `exports` in a published `package.json`, OpenAPI files | add them to `merge.hold_paths` |
| No tests | no test command found | warn: the factory's evidence is weaker; `merge.policy` stays `hold` |
| A large repository | more than 1 GB or 200,000 files | shallow clones; the dev-environment skill names the packages to install |

## 6. Output: factory.json

Write every key of the template's `factory.json`:

- `identity`: `kind` (`machine-user` or `personal`, onboarding step B); the
  setup agent writes `github_login`, `name` and `email` from the identity
  check's run line.
- `store`: the person's answer (section 2), with `target`, `agent_identity`
  and, for Asana or Jira, the `states` mapping read from the tool.
- `sources`: `github-issues` on; `tests` on when an end-to-end command exists
  (else off, and `source-tests` disabled); every other source on only when its
  evidence exists, its credential is set, and the person said yes. Every
  enabled source also gets `enabled: true` on its trigger in factory.yaml
  (`kortix triggers enable <slug>`), and a disabled one `enabled: false`.
- `caps.workers`: 3 by default; 1 when the dev environment is heavy (more than
  ~4 GB of services).
- `merge.policy`: `hold`. Write `auto` only when the person answers yes to
  "May the factory merge pull requests that pass every gate?".
- `merge.hold_paths`: from section 5.
- `models`: the person's plan (generic guide step 7); `reviewer` and
  `worker_hard` the strongest model `kortix models ls` lists.

Then report to the person in at most 12 lines: the store, the enabled sources
and why, the sources left off and what each one needs, the merge policy, the
risks found.
