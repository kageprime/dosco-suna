# Draft file

Path: `<channels.social.drafts_path>/<date>-<platform>-<topic-slug>.md`.
`<date>` is the suggested posting day (`YYYY-MM-DD`). The id is the file name
without `.md` and is never reused.

```markdown
---
platform: x
date: 2026-01-15
topic: csv-export
proof: https://github.com/<owner>/<repo>/pull/412
media: marketing/social/media/2026-01-15-x-csv-export.png
status: draft
---

Export any report as CSV from the Reports page, filters included.

Open a report, choose Export, pick CSV. (#412)

<proof-or-blog-url>
```

Rules:

- `status` is `draft`. A person changes it to `posted` with the post's URL in
  `posted_url` after posting, if they want the record.
- `media` is a repository path under the drafts folder, or `none`. Images
  over 5 MB are attached to the pull request instead (`agents/marketing.md`).
- The body is the exact text to paste. No notes in it: notes go in the pull
  request body.
- `<proof-or-blog-url>` stays a placeholder only when the blog post is not
  merged yet; say so in the pull request body.
