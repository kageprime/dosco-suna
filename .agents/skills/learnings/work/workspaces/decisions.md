# Workspaces — decisions

## 2026-11-05

**D1 (decided, Marko).** Workspace = the Slack model. 1 workspace = 1 company,
each independent, everything per workspace, billing per workspace. "Project"
leaves the UI, CLI and docs. API and SDK get `workspace` names; `project`
names stay as `@deprecated` aliases. No org layer above workspaces for now.

**D2 (open). The public workspace id.** Proposed: `project_id`.

- `project_id` keys every session URL, SDK call (`useSession(projectId, …)`),
  `KORTIX_PROJECT_ID` in every sandbox (436 references) and the manifest.
  With 1:1, `project_id` names the workspace without ambiguity, and every
  existing link keeps working. The account is reached through
  `projects.account_id`, which is always unique.
- `account_id` would make the id exist before a repo is provisioned, but it
  re-keys the runtime and is ambiguous for the 401 legacy accounts until they
  are split.

**D3 (open). Personal workspace at signup.** Proposed: none, like Slack.
Signup asks "Create a workspace or join one". Today signup bootstraps a
personal account (`apps/api/src/accounts/core/accounts.ts`); 40,618 of them
never got a project.

**D4 (open). The 401 accounts with several projects.** Proposed:

1. Block new second projects (stage 9) first.
2. Split each extra project into its own workspace: a new account with a copy
   of the memberships and roles; the project row and every row that
   denormalizes its `account_id` move to the new account.
3. The most active project (most sessions created in the last 30 days, then
   the most recently opened; changed 2026-11-06) keeps the original account, its credits,
   Stripe customer and plan. The split workspaces start on the free plan.
4. The 36 accounts that ever purchased credits are split only after their
   owner chooses the workspace that keeps billing. 0 have an enterprise
   contract.

**D3 (decided, Marko 2026-11-05).** No auto-created account at signup. A new
user sees the existing chooser as "Create a workspace or join one".

**D2, D4 defaults (Marko: "go execute", 2026-11-05).** Workspace id =
`project_id`. Legacy multi-project accounts are grandfathered in PR 1; the
split comes later.

**D5 (open). Does joining a workspace grant access to it?** Today account
membership and project access are separate grants (the account hub's
"Projects" tab manages project access). In a Slack workspace, joining is
access. Proposed: a workspace invite always carries the project grant (role
chosen at invite), and Members shows one list with each person's project role;
a member without a grant shows "No access" with "Grant access". No IAM engine
change, so the 11 accounts with several members and several projects keep
their per-project privacy.

## 2026-11-05 (evening)

**D6 (decided, Marko).** PR #11857 unifies everything end to end, not only the
product: data, API, SDK, CLI and IAM all become "workspace" ("this pr should
fully address it properly e2e").

**D7 (decided, Marko).** Backward compatibility stays permanently: old routes
(`/v1/projects/*`, `/v1/accounts/*`), SDK `Project*`/`Account*` exports, the CLI
`projects` command, `KORTIX_PROJECT_ID` and the old DB names. There is no later
drop step ("all compatibility & backwards comp should stay").

**Constraint (measured 2026-11-05, prod estimates).** 205 tables carry
`account_id` and/or `project_id`; `audit_events` is ~400 GB, `gateway_request_logs`
48 GB, `credit_ledger` 8.6M rows. Rewriting id values on those tables is not
feasible in one release; the identity design must avoid it.

**Defaults taken (Marko may veto).** Project name wins in the account-name
backfill (old names kept in a backup table). The 401 multi-project accounts are
split automatically: the most recently opened project keeps the account, its
credits and subscription (2026-11-06, Marko: the most active project instead, see
`split-runbook.md` "Keeper and holds"); every move is logged and reversible. The 40,618 empty
accounts stay as dormant records.

## 2026-11-06

**D5 (closed, Marko 2026-11-06, "Hardcore treat everything 100% like SLACK
Workspace").** Joining a workspace is access. Engine rule (design.md §3.2 C3):
an account-scope system `member` reaches its account's workspace at the
`member` tier when the workspace is not `split_pending`. No data migration;
`split_pending` accounts keep per-project grants until the split.

**D8 (decided, Marko 2026-11-06, "it should all just be 'workspace'").** Fold
hard into one primitive, the workspace, with one id, `workspace_id`. Account
and project stop being concepts in the data model over three releases
(design.md §0, §2). Compatibility stays at the edge permanently: the legacy
routes, the deprecated `account_id` field, and the `legacy_account_id →
workspace_id` lookup. Supersedes D7's "the old DB names stay".

**D9 (decided, Marko 2026-11-06, "there will just be Workspace scopes … just 1
type & then agent either can or cannot").** One auth model (K1): a
workspace-bound credential reaches every route of its own workspace; the
person's grants decide, or `grant ∩ ceiling − HUMAN_ONLY` for a governed agent.
`HUMAN_ONLY` (minting credentials, moving money, deleting the workspace) is the
only agent wall. `WORKSPACE_ADMIN_PROJECT_ACTIONS` and
`isWorkspaceAdministration` are deleted.

**D10 (decided, Marko 2026-11-06, plan approval "yea go revamp").** Workspace
lifecycle = account lifecycle (K2). `DELETE /v1/workspaces/:id` closes the
account in the same transaction as the project archive (14-day grace,
credentials revoked, automations paused, subscription set to cancel at period
end); owners restore it until `deletion_scheduled_for`; the account-deletion
sweep erases it after. A create never reuses an account (only an idempotent
replay of the same create returns one). "Delete my account" deletes the
person: sole-owned single-member workspaces go with them, they leave the
others, a sole owner of a shared workspace is refused with the list, and the
login goes last. Built in R1 by the identity stream.

**D11 (decided, Marko 2026-11-06, plan approval).** Split billing (K4): the
paying rule is `kortix.account_is_paying` (paid tier, purchased credits, or an
active enterprise contract; a bare `stripe_subscription_id` never counts). A
free source's split-off keeps free-credit eligibility and gets one Free grant
(a one-time exception); a paying source's split-off gets the keeper's plan
comped until the keeper's current period ends, with pro-rated plan credits.
Each affected workspace shows a notice for 30 days; each OWNER gets one email,
in `apply` mode only, never a bulk email.

## 2026-11-10

Release 2 and 3 handed from Marko to Dimitrije (Slack, 2026-11-10).

**D12 (decided, Dimitrije 2026-11-10, "it's okay that most used project keeps
the billing").** A paying legacy account is not held for an owner's keeper
choice. The keeper rule (the most active project, `split-runbook.md` "Keeper
and holds") decides which project keeps the account, its plan, credits and
Stripe customer, as for a free account; the split-offs get the D11 billing.
`confirm-keeper` stays as an operator override before the account's first
move. Supersedes D4 item 4, the "Paying holds, D3" rule (design.md §3.3) and
the open owner-confirmation deadline (design.md §3.6 item 7). The
identity-provider hold stays. Why: nothing released a held account but an
operator command per account; on prod, 2026-11-10, 90 paying accounts
(277 moves, the Kortix team's own account among them) were held, so the
Release 2 gate "0 `split_pending`" could not be reached.


## 2026-11-11

**D13 (decided, Marko 2026-11-11, "no owner notices").** The split notifies
no owner, before or after a move, on prod, staging and dev. There is no notice
period before `apply`, no owner email and no other message: the
`workspace_split_emails` outbox and its sender are removed from the split
worker (the table stays, empty). Supersedes the owner email of D11 and K4, C9's
"Owner email", the open decision on the email text (README, 2026-11-10), the
confirmation-window schedules, and the runbook step "tell the owners of
accounts with staying tokens, keys or OAuth clients first". Switching an
environment to `apply` still needs Marko's explicit go. Not covered by the
quote and unchanged, open with Marko: the in-product split banner. For 30
days after the account's last move, `GET /v1/workspaces/:id` carries
`split_notice` (C9), and `SplitNoticeBanner`
(`packages/ui/src/workspace/settings/split-notice-banner.tsx`) shows it on the
workspace home and in Settings › General to everyone who can read the
workspace. It sends nothing.
