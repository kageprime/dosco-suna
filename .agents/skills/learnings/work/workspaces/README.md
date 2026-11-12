---
title: Workspaces — one account, one project, one concept (the Slack model)
status: Release 1 LIVE on prod (v0.15.3, 2026-11-10); Release 2 and 3 specified in design.md, not built; the split runs in dry_run until the sandbox-key fix is released
owner: dimitrije (from marko, 2026-11-10)
updated: 2026-11-10
---

# Workspaces

## The problem

Users do not understand "project". They read it as a small unit of work that
they create per task. A teammate asked whether a new content system needs a
new project. The answer is no: one company works in one place.

The data agrees. Kortix already behaves like a Slack workspace; the product
names it wrong.

Prod, read-only aggregates, 2026-11-05:

| Measure | Count |
|---|---|
| Accounts | 49,068 |
| Accounts with 0 active projects (personal accounts bootstrapped at signup) | 40,618 |
| Accounts with exactly 1 active project | 8,049 (95.3% of accounts with a project) |
| Accounts with 2+ active projects | 401 (1,034 projects); max 23 |
| … that opened 2+ projects in the last 30 days | 25 |
| … that ever purchased credits | 36 |
| … active 2+ and ever purchased | 11 |
| … with an active enterprise contract | 0 |
| Users who belong to 2+ accounts | 58 of 49,032 |

The copy is also inconsistent. In `apps/web/translations/en.json` the word
"workspace" already means 4 things: the account, the project, a Slack
workspace, and the sandbox ("The workspace went to sleep").

## The decision

**A workspace is the only top-level concept, exactly like a Slack workspace.**

- 1 workspace = 1 company. Each workspace is independent.
- Everything is per workspace: members, roles, groups, SSO, MFA policy,
  billing, credits, plan, secrets, connectors, agents, skills, Drive,
  sessions, triggers, apps, the model gateway, audit.
- A user can belong to several workspaces and switches between them.
- There is no organization above a workspace. An Enterprise-Grid-style layer
  (one contract over many workspaces) is added only when a real enterprise
  customer asks for it.
- "Project" disappears from the UI, CLI and docs. The API and SDK get
  `workspace` names. The old `project` names stay working as `@deprecated`
  aliases.
- Internals keep their names: tables, columns, `apps/api/src/projects/`. A
  physical rename happens only if it pays for itself.

### Mapping onto today's model

| Concept | Today | After |
|---|---|---|
| Workspace | `accounts` row + its one `projects` row | one thing in every user-facing surface |
| Billing, members, IAM, SSO | `accounts` | unchanged storage, shown as workspace settings |
| Config repo (`kortix.yaml`, agents, skills) | `projects.repo_url` | the workspace's config repo, invisible to most users |
| Code repos | one per project | later: connected resources of a workspace (stage 4) |
| Personal account | bootstrapped at signup | see D3 |

## Glossary (the copy contract)

| Word | Means | Never means |
|---|---|---|
| Workspace | the company's Kortix (account + project) | a sandbox, a Slack workspace, a folder |
| Sandbox / cloud computer | the session's machine (brand kit noun table) | a workspace |
| Computer | a person's own machine connected to Kortix (brand kit) | a sandbox, a workspace |
| Slack workspace / Teams tenant | the chat platform's own unit; always qualified | a Kortix workspace |
| Space | a channel-like room inside a workspace (`project_spaces`) | a workspace |

Rename the code identifiers that collide with "workspace" in the same branch:
`chat_installs.workspace_id` / `chat_threads.workspace_id` (Slack team id),
`capture_workspaces`, and `packages/ui/src/workspace/` (layout code).

## Prior attempt: #5480 (closed, not merged)

`refactor/projects-to-workspaces` (head `ca3630c5f0`, 2026-08-11) renamed
Project → Workspace across 2,296 files (+76,783 / −46,107) in one PR. It fell
799+ commits behind and could not be rebased. Marko closed it 2026-09-26; the
vocabulary decision stood.

What to reuse: its compatibility-alias design — deprecated `/v1/projects`,
`/projects/**` web redirects, `kortix projects`, `KORTIX_PROJECT_ID` fallback,
every SDK `Project*` export kept.

What it did not do: it kept many projects per account ("route account entry
points to the account default Workspace"). This plan makes account:project
1:1.

**The rule this time: no big-bang PR.** Each stage below is a PR that lands
on `dev` within a day or two. Each one is green and shippable alone.

## Size of the surface

| Surface | Count (2026-11-05, `dev` 79871435a6) |
|---|---|
| API routes under `/projects` | 491 of 991 (`tests/spec/routes.generated.json`) |
| SDK exports containing `Project` | 298 |
| English strings containing "project" | web 1,157, `@kortix/ui` 487, mobile 15 — 9 locales each |
| Web pages under `/projects` | 33 `page.tsx` |
| `KORTIX_PROJECT_ID` references | 436 |
| Manifest `project.*` actions | 68 |

## Stages

Each stage is its own PR on branch `workspaces` or a sub-branch merged back.

1. **Spec** (this folder).
2. **Copy.** All catalogs: "project" → "workspace", the other meanings of
   "workspace" → the glossary word. A ratchet test: the count of "project"
   in user-facing English catalogs can only go down, so new copy cannot drift
   back. Visual/brand change → held for Marko's merge OK.
3. **Web routes.** `/workspaces/<id>/…` is canonical. Every `/projects/<id>/…`
   URL redirects (bookmarks, shared session links, emails).
4. **Navigation and settings.** The account switcher and the project selector
   become one workspace switcher. Account settings + project settings become
   one Workspace settings. "New project" is removed; "Create workspace"
   creates the account and its project in one step.
5. **API.** `/v1/workspaces/…` as the primary names; `/v1/projects/…` stays
   as a deprecated alias. Route manifest and flows updated.
6. **SDK.** `workspace` names added (TDD, the `sdk` skill); every `Project*`
   export kept with `@deprecated`. No export removed.
7. **CLI and runtime env.** `kortix workspaces`, `KORTIX_WORKSPACE_ID`
   (kortixd falls back to `KORTIX_PROJECT_ID`). `kortix projects` stays as a
   deprecated alias.
8. **Docs and skills.** `apps/web/content/docs/developers.mdx`,
   `packages/sdk/README.md`, every skill that says "project".
9. **Enforce 1:1 for new data.** Creating a second project in an account
   returns `409`. Then the legacy split (D4), then a unique partial index on
   `projects(account_id) where status = 'active'`.
10. **Later, separate initiative:** code repos as connected resources of a
    workspace, so a developer with 5 repos has 1 workspace, not 5.

## Status (2026-11-10, evening): Release 2 and 3 handed to Dimitrije

Prod, read-only, 2026-11-10 ~15:00 UTC. It corrects the table below.

| Gate item | Prod now |
|---|---|
| 0 `split_pending` projects | 1,036 in 401 accounts. Split still `dry_run` (no `workspace_split` setting). Plan: 635 moves, 358 from 311 free accounts, 277 from 90 paying accounts (all `account_has_billing`, 0 IdP). D12 removes the paying hold |
| 0 NULL `workspace_id` | The `workspace-id-fill` job FINISHED at 02:00 UTC (`workspace_id_fill_progress.finished_at`); nothing it can fill is left. Of the NULL `credit_ledger` rows (1% sample), ~71% belong to `split_pending` accounts (filled when they split) and ~29% to deleted accounts (no `accounts` row; they stay NULL, see design.md §2) |

Found before `apply`: the split left a moved session box's legacy sandbox key
(`kortix.api_keys`, type `sandbox`) on the source account, so the git proxy
refused it (`403 sandbox token is not scoped to this workspace`). ~3,200 keys
sat on the projects to move, 382 used in the last 7 days. Fixed in
`moveProjectRows` (transfer, split, repair and reverse); proven in
`project-transfer.integration.test.ts`.

Order from here (each prod step needs Dimitrije's go):

1. Release the sandbox-key fix and D12 (one release driver).
2. `workspace_split` = `apply` on prod; `workspace-invariants` after each batch.
3. Build R2a (design.md §4) while the split runs; then R2b; R3 after a
   rehearsal on a restored snapshot (§5).

Of the decisions below, 2 (the confirmation window) is closed by D12, and 1
(the owner email text) by D13 (2026-11-11, "no owner notices": the split
sends no email and has no notice period). Still open: 3, the soak length.
`apply` itself still needs Marko's go.

## Status (2026-11-10)

**Release 1 is live on prod** in v0.15.3 (release PR #12175, deployed
2026-11-10 01:49 UTC). Feature PR #11857, plus #12014 (Docker build) and
#12214 (migration fix, see below). Verified on prod with a synthetic user:
15/15 checks (no workspace → `409 no_workspace`, `new_workspace` provision,
`/v1/workspaces` and legacy `/v1/projects` routes, keys acting as me/bot,
read scope `403`, revoke `401`).

Prod state against the Release 2 gate (`design.md` §2), read-only, 2026-11-10:

| Gate item | Prod now |
|---|---|
| 0 `split_pending` projects | 1,036 marked. The split worker runs in `dry_run`: last plan 2026-11-10 01:41 UTC, 635 moves, 0 owner emails sent |
| 0 NULL `workspace_id` on the expand tables | the `workspace-id-fill` job is running; `credit_ledger` has 8.9 M of 9.6 M rows NULL (~0.73 M filled in the first ~9 h) |
| 0 shadow mismatches for 7 days | the count starts when the split has run |
| Invariants I1–I12 exit 0 | not run on prod yet |
| 0 lint suppressions for direct `accounts`/`projects` imports | met |

Decisions open with Marko (needed before any Release 2 work ships):

1. The owner email text and switching the split to `apply` on prod
   (`split-runbook.md`, "Mode").
2. The confirmation window for held accounts (paying, IdP): 48 h, 7 days or
   14 days. It sets the earliest Release 2 date.
3. Whether the shadow-mismatch soak is 2 or 7 days.

Schedules discussed 2026-11-10 (each step still needs Marko's go):

| Plan | Split | Release 2a | Release 2b | Release 3 (~2 min) |
|---|---|---|---|---|
| Fast (48 h window, 2-day soak, accelerated fill) | 11-10 | 11-14 | 11-16 | 11-23 (R2b live 7 days; 11-19 at 3 days is the shortest I would back) |
| Default (7-day window, 7-day soak) | 11-10 | 11-24 | 11-26 | 12-03 |

Release 3 needs a rehearsal on a restored prod snapshot first (`design.md` §5).

Incident from the Release 1 deploy (learnings ledger, 2026-11-10, "Never
INCLUDE a jsonb..."): two intermediate gateway_logs covering indexes
INCLUDEd `metadata`, which exceeds the btree tuple limit on prod rows. Prod
was recovered by hand. #12214 skips both builds through a checksum-guarded
runtime override, so a self-host upgrade passes. Self-host `:stable` was not
moved; it should move only with a release that contains #12214.

Other follow-ups:

- Drata compliance-as-code reports 2 critical findings without an
  infrastructure change. Its exclusions must be re-created on pipeline 28 by
  someone with Drata access. The check is advisory in the release gate.
- On staging and dev a free-tier account has no platform default model, so
  its sessions never boot (`pi harness has no model`). Older than Release 1;
  prod not checked.
- `kortix whoami --json` through the MCP tool: #12197 bounds the accounts
  list on `dev` (not yet released).
- #12133 lets the session's own member pick their provider keys without
  `project.secret.read` (it reverts part of #12063). Marko has not confirmed.

## Status (2026-11-06)

- The current spec is `design.md` (§3 Release 1, §4 Release 2, §5 Release 3).
  The stages below are the 2026-11-05 plan, kept for history.
- D1–D5 and D8–D11 are decided (`decisions.md`). D7's "old DB names stay" is
  superseded by D8.
- Release 1 identity (sub-branch `ws-r1-identity`): `kortix.workspaces` is a
  table kept in sync by triggers, the 44 expand tables carry `workspace_id`,
  the store answers with shadow reads, delete closes the account, "Delete my
  account" deletes the person, and a create never reuses an account.

## Open decisions

See `decisions.md`.

## Pick it up

- Release 1 is merged and the `workspaces` worktree is removed. Start
  Release 2 on a new canonical branch: `pnpm worktree create --name
  workspaces-r2 --db --yes --no-start` (its migrations need an own database).
- Prod numbers: read-only `DATABASE_URL` from `apps/api/.env.prod`,
  aggregates only, no IDs or names in tracked files.

## Next PR: one scope — the workspace (Marko 2026-11-05)

Marko: "there will just be Workspace scopes not the account level or project
level, just 1 type & then agent either can or cannot, no more of this confusion
having 2 sys".

Today there are two scope systems:

- IAM: `role_assignments.scope_type` is `account` or `project`; the action
  catalog has `account.*` and `project.*` actions; owners and admins are
  implicit managers of every project.
- Credentials: account tokens vs project/session-scoped PATs, fenced by a
  per-route allowlist in `enforceTokenProjectScope`
  (`apps/api/src/middleware/auth-scope.ts`). An agent in a session ran
  `kortix feedback` and got 403 from that fence (PR 1 allows `POST /v1/feedback`
  as the stopgap).

Target:

1. One scope: the workspace (id = `project_id`). Every grant, role and
   credential names one workspace. Account-scope assignments become workspace
   assignments; `account.*` and `project.*` actions become `workspace.*`
   (old names kept as aliases on the wire for old CLIs and daemons).
2. One fence: a credential reaches its own workspace and nothing else. The
   allowlist is deleted.
3. One decision: `authorize(actor, action, workspace)`. A person or an agent
   (`agent_session` in `iam/actor.ts`) either holds the grant or does not. An
   agent never inherits workspace administration (billing, members, roles,
   SSO, keys) from the person who started its session.
4. Legacy accounts with 2+ projects: each project is a workspace for IAM;
   actions on the shared account rows (billing, members, SSO) need the grant
   on every project of the account, or the owner role, until the split.
5. Proof before cutover: a verdict-parity table over every route in
   `tests/spec/routes.generated.json` × credential kind × (1:1, legacy) ×
   role, old engine vs new, with every difference listed and approved. The
   2026-08 RBAC cutover (#6554) used the same harness shape.
