# Skill: dosco-foundations

Dosco is a managed product that diverges from upstream on purpose. An upstream
merge or pull must not silently undo that work. This skill owns the list of
decisions that must survive, and the gate that proves they did.

## What a foundation is

A foundation is a Dosco decision that would be lost in an upstream merge and
would cost real work to restore: brand wording, a sovereign provider, a retired
feature, a build constraint, or an approved design.

Not a foundation: an ordinary bug fix, a test that already covers a behavior, or
an upstream improvement that does not change a Dosco decision.

## When to check

Run the gate after every upstream merge or pull, before the merge is committed:

```sh
bun test tests/unit/dosco-foundations.test.ts
bun test apps/api/src/platform/providers/dosco-sovereignty.test.ts
bun test apps/web/src/config/turbopack-build-cache.test.ts
bun test tests/unit/dosco-brand-surfaces.test.ts
```

The first gate is listed with the other mandatory gates in `AGENTS.md` §5.
A red foundation gate blocks the sync: resolve the conflict by restoring the
Dosco decision, or update the row deliberately in the same PR and say why.

## When to add a row

A Dosco change is not done until it has a foundation row. Do it in the same PR:

1. Add the row to `references/foundations.json`. Use the smallest check that
   proves the decision: `file-exists`, `file-absent`, `contains`, `excludes`,
   `excludes-tree`, or `sha256` (see `references/registry.md` for status rules).
2. Run `bun test tests/unit/dosco-foundations.test.ts` and make it green.
3. Describe the row in `references/registry.md`.

If an incident shows a merge broke a foundation, record a learnings entry and
strengthen or add the assertion in the same session.

## Resolving a red gate

1. Read the failing row's `id` and `surface` in `references/foundations.json`.
2. Compare the surface with the pre-merge commit and with `upstream/dev`.
3. Restore the Dosco decision. Keep upstream code-level fixes where they do not
   change the decision — a frozen file is the exception: restore it exactly.
4. Re-run all four gates and the `apps/web` typecheck before committing.
