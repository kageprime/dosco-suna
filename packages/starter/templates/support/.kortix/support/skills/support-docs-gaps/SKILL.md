---
name: support-docs-gaps
description: Close help-center gaps that support conversations reveal - questions customers ask again and again that no docs page answers - with at most one pull request a week into the help-center repository, every new sentence sourced from the code or existing docs. Load it from the support-docs-gaps trigger, or when a person asks to update the help center from support.
---

# Support docs gaps

Trigger `support-docs-gaps` (weekly, Tuesday 09:00 UTC). Disabled by
default. Needs `GH_TOKEN` with write access to
`knowledge.help_center_repo`, and `knowledge.help_center_path`. Output: at
most `caps.docs_prs_per_week` pull requests. The `support-loop` contract rules
apply.

## 1. Find the gaps

1. Read the newest `Support clusters` Review output
   (`support-feedback-clustering`). Its docs gaps are the candidates. None
   this week: run its steps 1 to 3 for `how-to` only.
2. For each candidate, search the help center (`grep -rn` in a clone of
   `knowledge.help_center_repo` at `knowledge.help_center_path`, and the
   public `knowledge.docs`). A page that already answers it is not a gap: the
   problem is findability. Note it in the pull request as a title or a link
   change, not a new page.
3. Keep the top 3 gaps by `customers_30d`.

## 2. Write the change

```sh
gh repo clone <help_center_repo> /tmp/support/docs -- --depth 1
git -C /tmp/support/docs switch -c kortix/support-docs-<ISO date>
```

- Follow the help center's own format: front matter, headings, file names,
  the sidebar or index file. Read two neighbouring pages first.
- Each page answers one question in its first sentence, then numbered steps.
- Every statement has a source: an existing docs page or the code
  (`knowledge.code_repo`, `file:line`). Never invent a limit, a price, a plan
  name or a date.
- No customer data, no quotes from conversations. Examples use `example.com`
  and synthetic names.
- Run the docs build or link check when the repository has one
  (`package.json` scripts, `mkdocs build`, `docusaurus build`). It fails: fix
  it or drop that page.

## 3. Open the pull request

```sh
git -C /tmp/support/docs commit -am "docs: answer <n> recurring support questions"
git -C /tmp/support/docs push -u origin HEAD
gh pr create --repo <help_center_repo> --title "docs: answer <n> recurring support questions" --body-file /tmp/support/docs-pr.md
```

The body: per page, the question, `customers_30d` (a count, never names), the
sources it was written from, and what a reviewer checks. Never push to the
default branch. Never merge: a person reviews and merges. An open
`kortix/support-docs-*` pull request from an earlier week: add to it instead
of opening a second one.

Then one Review output that links the pull request.

## 4. The run line

```
support-docs-gaps: candidates=<n> gaps=<n> pages_new=<n> pages_changed=<n> pr=<url|none> errors=<none|code>
```
