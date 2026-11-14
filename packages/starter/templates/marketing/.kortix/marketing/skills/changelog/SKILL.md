---
name: changelog
description: Turn merged pull requests and pushes on the default branch into changelog entries, in the repository's own changelog format, on one rolling pull request (`kortix/marketing-changelog`). Load for the `changelog` role (a merged pull request or the daily sweep), and whenever a person asks to update the changelog. The changelog is the source every other marketing skill reads.
---

# Changelog

One rolling pull request holds every entry since the last merge of it. Each
line tells a user what they can now do, or what no longer breaks. Every line
comes from a commit or pull request you read.

## Steps

1. **Find the changelog.** `site.changelog_path` in marketing.json; `null`:
   detect it as `references/format.md` says, and name what you found in the
   pull request body so a person can set it.
2. **Open the branch.** `gh pr list --head kortix/marketing-changelog --state open`.
   It exists: check out `kortix/marketing-changelog` and rebase it on
   `origin/<trunk>`. Else create it from `origin/<trunk>`.
3. **Find the range.** Start after the newest change the changelog already
   covers (its date, version or listed pull request numbers). List merged
   pull requests with
   `gh pr list --state merged --base <trunk> --search "merged:>=<date>" --json number,title,body,mergedAt,labels,url`
   and direct pushes with `git log --no-merges <start>..origin/<trunk>`.
   A webhook run adds its one pull request; the daily sweep adds all.
4. **Choose** what goes in with `references/selection.md`. Read the diff when
   the title does not say what changed for a user.
5. **Write** each kept change as one line in the file's own format
   (`references/format.md`): under the unreleased section, or under today's
   date when the file is dated. Never edit a released section.
6. **Commit** `docs(changelog): <summary>` and push. No open pull request:
   open one, title `docs(changelog): <first date> to <last date>`, labels
   `marketing` and `marketing:changelog`. Update the body every run:
   included pull requests, skipped ones with the reason, `Needs a person`.
7. Nothing user-visible in the range: push nothing. End with
   `changelog: created=0 updated=0 skipped=<n> …`.

## Rules

- Never a feature, number or benefit the commit or pull request does not show.
- An unclear change stays out, listed under `Not included` with the reason.
- Never edit the changelog on `<trunk>` directly; a person merges the pull
  request.
- Group lines the way the file already groups them (Added, Changed, Fixed,
  Removed, Security, or the file's own headings).
