# Source: codebase analysis

Trigger `source-codebase-analysis` (cron, Tuesdays 04:00 UTC, one review unit
per pass). Disabled by default. Setting: `sources.codebase-analysis.units`, a
list of `{id, paths}`; empty means the analysis builds the list (step 1).
Read-only: this source never edits code.

| | |
|---|---|
| Signal | one review unit (a package, an app, a top-level module) of the trunk |
| Finding | a substantive improvement: dead code proven unused, duplicate paths that become one, a module boundary violation, needless layers, a correctness risk found while reading |
| Bar | **verified** at the trunk commit (every cited range re-read); **high confidence** (you can name the exact change, the tests that prove behavior is unchanged, and the metric before and after); **worth one PR** (at least ~150 changed lines or 3 findings of one unit in one checklist; smaller findings go to the per-unit cleanup digest); never cosmetic (a rename, a reformat, a file split that removes no concept). Dead code only with proof: `git grep -w <name>` finds only the definition, and no build file, script or config names it |
| Key | `code:<unit id>:<finding slug>`; the cleanup digest `code:<unit id>:cleanup` |
| Signal value | `signal: loc=<n> duplicates=<n> dead_exports=<n> complexity=<n>` for the unit |
| Priority | 2 a correctness risk (its own ticket, `kind:bug`); 3 refactors in files changed at least 5 times in 30 days; 4 others |
| Kind | `refactor` (`bug` for a correctness risk) |
| Credentials | `FACTORY_GITHUB_TOKEN`, read-only use |

## Run

1. **Units.** None configured: list the workspaces (`pnpm-workspace.yaml`,
   `package.json` `workspaces`, `go.work`, Cargo workspace, top-level source
   folders) as units, write them into the `code:ledger` ticket body as a
   coverage table `unit | paths | last reviewed | sha`.
2. **Pick** the unit reviewed least recently (never reviewed first). Clone the
   trunk read-only; record the commit.
3. **Measure** in code: lines per file, exported names with no importer
   (`git grep -w`), duplicate blocks (`jscpd` or a token hash when installed,
   else reading), import cycles, churn (`git log --since=30.days --name-only`).
4. **Read deep**: the hot spots first (high churn and high size). Read the
   repository's own rules (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`,
   architecture notes) and treat a violation of a written rule as a finding.
5. **File** at most one refactor ticket per unit per pass: every finding of the
   unit as one checklist in `## Proposed change`; `## Acceptance` = behavior
   unchanged (characterization tests that pass before and after), net lines
   removed, the named boundary clear. A correctness risk is its own `kind:bug`
   ticket. Smaller findings: append to `code:<unit>:cleanup`; release it as a
   ticket when it holds 5 items or is 14 days old.
6. Update the `code:ledger` coverage row (unit, date, commit, findings filed).
7. End with `source-codebase-analysis:`, the contract run line,
   `unit=<id> sha=<sha7> findings=<n>`.
