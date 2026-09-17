# Fork sync — pull `kortix-ai/suna` (upstream) into a Dosco branch

Remotes in every checkout of this repo:

- `origin` = `https://github.com/kageprime/dosco-suna` (ours)
- `upstream` = `https://github.com/kortix-ai/suna` (source of truth)

Syncing means merging `upstream/main` into a branch. It is a branch-only
operation: no containers, no images, no database changes.

## Everyday pull (branch already tracks origin)

```sh
git status -sb            # must be clean before anything moves
git pull --ff-only        # fails loudly instead of creating a surprise merge
```

Two setup gotchas this repo has hit:

1. This clone's `remote.origin.fetch` refspec covers `main` only, so other
   branches are invisible until added:
   `git remote set-branches --add origin <branch> && git fetch origin`.
2. A branch with no upstream tracking makes `git pull` fail. Set it once:
   `git branch --set-upstream-to=origin/<branch> <branch>`.

Verify with `git rev-list --left-right --count HEAD...upstream/main`
(stale fetch lies — run `git fetch upstream main` first).

## Full upstream sync (branch is behind upstream)

```sh
git status -sb                                    # clean tree required
git branch backup/<name>-pre-sync <branch>        # rollback point
git fetch upstream main
git checkout <branch>
git merge upstream/main --no-edit
```

Merge-base reference: `git merge-base <branch> upstream/main`.

### Conflict policy: upstream structure, Dosco additions inline

- Upstream refactors win (routes, sidebar, i18n catalog shape). Re-apply the
  Dosco delta on top; never graft old Dosco files over new upstream code
  (e.g. never resurrect files upstream deleted).
- Dosco-only files (Paystack billing, brand assets) stay untouched.
- Recurring conflicts and their resolutions:
  - `capability-tab-routes.ts` / `project-settings-nav.tsx` — keep the
    upstream tab structure, re-add the `marketplace` key/segment/preference,
    update the order test.
  - `apps/web/translations/en.json` — take upstream strings, re-apply the
    bare-noun renames (no `Kortix…` in values; key slugs keep their names).
    Keep it valid JSON; `bun test src/i18n/i18n-complete.test.tsx` must pass.
  - `docs/ENTRA_SSO_SCIM_SETUP.md` — upstream's expanded SCIM text with
    Dosco naming.
  - `packages/db/drizzle/meta/_journal.json` — union: keep our entries,
    append upstream's, renumber `idx` sequentially. All referenced
    `meta/*_snapshot.json` files must exist.
  - `packages/starter/src/embedded.generated.json` — never hand-edit;
    regenerate with `bun run scripts/generate-embedded.ts` from
    `packages/starter/`, then run its tests.
  - `pnpm-lock.yaml` — take upstream unless our side added a dependency.
- Generated/derived files are verified, not reviewed line by line
  (JSON validity, scaffold sync test, `pnpm install --frozen-lockfile`).

### Migration ledger landmine

`kortix-migrate` runs node-pg-migrate with the order check on: the file set
must contain every migration recorded in `kortix_migrations.pgmigrations`,
in the same relative order. Concretely, `packages/db/migrations/
20260909134742448_paystack_columns.sql` must exist in any tree whose image
boots against the production database — it ran there 2026-09-09 and its
absence fails boot with `Not run migration … is preceding already run
migration …`. Never rename or delete a migration file that has run anywhere.

## Finish

```sh
git rev-list --left-right --count HEAD...upstream/main   # expect: N 0
git push origin <branch>
```

Run the focused tests for the areas the merge touched (capability tabs,
settings-nav contract, sidebar suite, i18n). Rebuilds, recreates, and deploys
are separate tasks — a sync never triggers them.
