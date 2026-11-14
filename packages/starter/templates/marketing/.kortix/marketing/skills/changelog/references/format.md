# Find and match the changelog format

## Find it

Look in this order and take the first that exists:

1. `site.changelog_path` in marketing.json.
2. `CHANGELOG.md`, `CHANGES.md`, `HISTORY.md` at the repository root or in
   the site's root (`site.root`).
3. A changelog route or content folder in the site: `content/changelog/`,
   `src/content/changelog/`, `docs/changelog*`, `src/app/**/changelog/`,
   `pages/changelog*`, `app/routes/changelog*`.
4. GitHub Releases only (`gh release list`): the repository keeps its
   changelog there. Do not write releases. Report `errors=changelog-in-releases`
   and propose a `CHANGELOG.md` under `Needs a person`.
5. None: create `CHANGELOG.md` in the Keep a Changelog 1.1.0 format
   (https://keepachangelog.com/en/1.1.0/), with an `## [Unreleased]` section.

## Match it

Copy the newest entry's shape exactly:

- one file per entry (a content folder) or one file with sections;
- front matter keys and their order, date format, version labels;
- heading levels and group names;
- link style for pull requests (`(#123)`, a full URL, a short SHA);
- line length, punctuation, tense and person of existing lines.

A content folder with one file per entry: one new file per day, named the way
the newest file is named. Build the site when the entry is a page
(`dev-environment` commands) and open it once in a browser: it renders and
its links resolve.

## Line shape

`<What the user can now do, or what no longer breaks>. (<link>)`

- Good: `Export a report as CSV from the Reports page. (#412)`
- Bad: `Refactored export service and added CSV adapter.` (internal, no user outcome)
