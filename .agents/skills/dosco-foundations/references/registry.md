# Dosco foundations registry

This is the human-readable view of `foundations.json`. The JSON is the source of
truth for `tests/unit/dosco-foundations.test.ts`; this file explains the rows.

## Status meanings

| Status | Meaning |
|---|---|
| `frozen` | Do not take upstream's version of this file or surface. A hash or absence check pins it. |
| `brand-locked` | Upstream code may change. Customer-facing names, links and phrases must stay Dosco. |
| `behavior-locked` | Upstream code may change. The named helper or routing decision must stay. |

## Groups

- `SOV-01 … SOV-11` — sovereign platform: E2B provider, decoupled drive storage,
  Groq/Inworld → OpenRouter audio, Xera naming, Heroku and Vercel build envelope.
- `BRD-01 … BRD-08` — brand surfaces: no upstream GitHub links, no banned Kortix
  phrases in the English catalogs, CLI installer points at `kageprime/dosco-suna`,
  Dosco assets exist.
- `PRD-01 … PRD-05` — product decisions: marketplace retired, registry package
  removed, retired route answers 410, no marketplace links on the home page.
- `DSN-01 … DSN-03` — frozen home-page design, pinned by SHA-256 to the pre-sync
  `heroku-clean` state (`e8595227a3`).

## Adding a foundation

1. Add a row to `foundations.json` with a unique `id`, a `check`, and the smallest
   surface that proves the decision.
2. Run `bun test tests/unit/dosco-foundations.test.ts` and make it green.
3. Add one line here describing the row, in the matching group.
4. Put the row and the line in the same PR that introduces the decision. A Dosco
   change is not done until this is true.
