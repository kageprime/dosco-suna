---
name: create-pr
description: "Write the title and body of a Kortix pull request for a human reviewer who decides \"merge or iterate\" without reading the diff: English only, a Conventional Commits title that names the outcome, only Demo video and Quick verification, with detailed evidence linked. Uploads the video and screenshots with `gh pr create/edit --attach`. Load whenever you run `gh pr create` or `gh pr edit`, write or rewrite a PR title or description, attach a video or screenshot to a PR, or hand off finished work for review, even when the user only says \"open a PR\" or \"update the PR text\"."
---

# Create a pull request

The title and body are for a human who will not open the diff. Their one question is
**"Do I merge this, or send it back?"** Every line helps answer it. Cut a line that does
not, even when it is true and took effort to find. Keep the body short. Put detailed evidence in linked PR comments or artifacts so the
reviewer can inspect it without expanding the body.

This skill owns the PR text. The **contributing** skill owns the loop around it: branch,
commit, verify, record the demo, merge, deploy dev. Follow the section order in
[the PR template](../../../.github/pull_request_template.md). Use only `## Demo video` and `## Quick verification`, in that order. Keep both headings;
explain a non-visual video exception in one sentence.

## 1. Gather facts before you write

- `git log --oneline origin/dev..HEAD` and `git diff --stat origin/dev...HEAD`: what the
  branch changes.
- The verification you ran in this session: exact commands, results, and the commit they
  ran on. Never write a result you did not see. State skipped or blocked checks and their reasons; do not omit them.
- `gh pr checks <pr>` when the PR exists and a `test` or `preview` run happened. Pending is
  not PASS.
- The demo video, recorded and checked frame by frame (**contributing** step 4).

## 2. Title

- **English only.**
- `type(scope): <outcome>`, the Conventional Commits style that `git log` shows. The squash
  merge uses the title as the commit subject on `dev`, so the prefix stays.
- After the colon, write the outcome a user or operator notices, not the technique.
  - Yes: `fix(web): the session list keeps its scroll position after a new message`
  - No: `fix(web): memoize SessionList and move scroll ref into useLayoutEffect`
- At most ~72 characters. Lowercase after the colon. No trailing period.
- Add the Linear key at the end when there is one: `(KRTX-1234)`.
- Mark a breaking change with `!`: `feat(sdk)!: …`.

## 3. Body

**English only**, every section. Keep the template headings unchanged.

**Style rules.** Each one saves the reviewer a question.

- Describe behavior, not code. Name who (user, admin, agent, self-host operator), where
  (route, screen, CLI command, API route), what they now see or can do, and what happened
  before. Name a file or function only when it helps the reviewer verify the change.
- Be concrete. Numbers, routes, status codes, exact UI labels in quotes. "Faster" becomes
  "first token in 9 s instead of 19 s on a new session". Never "improved", "various",
  "some cleanup".
- One fact per sentence. No filler, no sales tone, no restating the title. The **How to
  communicate** rules in `AGENTS.md` apply.
- Say what is **not** affected when a reviewer would plausibly worry: migrations, IAM,
  billing, old OpenCode transcripts, self-host, mobile, desktop, prod data.
- Separate what you proved from what you believe. "Tested on Platinum" and "Daytona takes
  the same path, not tested" are two different claims.
- Explain a design choice only when the reviewer would otherwise ask "why not the obvious
  way?". One or two sentences.

**Leave out:** your process and dead ends, a file-by-file tour in prose, test internals the
reviewer will not check, anything the title or the video already shows, and repeated
caveats.

**Sections (no others):**

- **Demo video.** The attached demo and a short caption, or the non-visual exception below.
- **Quick verification.** Start with `Outcome: <what was accomplished>` in one sentence
  (or 1–3 high-level bullets). Then a few actionable checks: where to go, what to do,
  and the expected result. Summarize checks actually run and link detailed evidence. State material
  risks and failed, blocked or skipped checks. Link the issue when one exists.

Keep compact fenced commands and actual runner summaries under Quick verification when
required by evidence gates; a collapsed block is allowed. Link verbose logs, tested
commit/environment, design detail, RCAs, risk/rollback notes and longer review context
in PR comments or artifacts. Keep evidence accessible
and free of secrets and customer data. A shorter body does not reduce testing, safety,
independent-review or merge requirements. Never replace required checks with instructions
for the reviewer to run them.

## 4. Demo video and screenshots

Put the demo first, under `## Demo video`, so the reviewer sees the change before
reading the verification bullets. Record it with agent-browser on your worktree's local stack
(**contributing** step 4). Keep the files in the gitignored `output/pr/`.

- Before the video, write a bold caption: surface, route, viewport, state, and what to watch
  for. Example: **Web, `/projects/<id>/sessions`, 1440×900, signed in as a member: the
  "Retry" button under a failed turn now resends the prompt.** The reviewer knows where to
  look before the player loads.
- One flow per video, under 60 s, starting state to visible result. Add a second video for
  a second flow, each with its own caption.
- No user-visible surface (API, CLI, infra): record the terminal, or say in one sentence why
  a video adds nothing.
- Add a screenshot only for a static state the video does not make obvious. For
  before/after, use a two-column table:

  ```markdown
  | Before | After |
  | --- | --- |
  | ![before](./output/pr/before.png) | ![after](./output/pr/after.png) |
  ```

- Crop to the element (`agent-browser screenshot @eN "$PWD/output/pr/after.png"`) when the
  change is small on a big page, and say so in the caption.
- Check every frame and image for credentials, tokens, and real customer data. The repo is
  public and every attachment URL is public. Synthetic data only (`@example.test`).

## 5. Upload with `gh --attach`

Reference each file in the body by the same relative path you pass to `--attach`. `gh`
uploads it and rewrites the reference to a `github.com/user-attachments/assets/…` URL. Run
`gh` from the worktree root so the paths resolve. Never commit media or push it to a branch.
Limits, token types, and failure modes:
[contributing/references/attachments.md](../contributing/references/attachments.md).

```bash
gh pr create --base dev \
  --title "fix(web): the session list keeps its scroll position after a new message" \
  --body-file output/pr/body.md \
  --attach ./output/pr/demo.mp4 \
  --attach './output/pr/after.png#Session list after a new message'
```

Then confirm no local path is left:

```bash
gh pr view <pr> --json body --jq .body | grep -cE '\]\(\./output/'   # 0
```

When some uploads fail, `gh` still creates or updates the PR and exits non-zero. Re-run
`gh pr edit <pr> --attach` for the missing files.

## 6. Update an existing PR

- Read the live body first: `gh pr view <pr> --json body --jq .body > output/pr/body.md`.
  The old local file still holds `./output/pr/demo.mp4`; publishing it without `--attach`
  leaves a broken link.
- Keep what is still true, including uploaded `user-attachments` URLs. Replace what the new
  commits made stale. Do not append a changelog of iterations. The body reads as if written
  once for the final diff.
- When the behavior in the video changed, record again and pass the full body:
  `gh pr edit <pr> --body-file output/pr/body.md --attach ./output/pr/demo.mp4`.
  `--attach` without `--body-file` appends the file at the end of the body.
- Update the title too when the outcome changed: `gh pr edit <pr> --title "…"`.

## 7. Last check

1. Read the title and body as the reviewer. For each sentence: would deleting it make the
   merge-or-iterate decision harder? If not, delete it.
2. Check every claim against the final diff and the verification you saw.
3. Check that the title and body are in English.
4. Check for customer names, people's names, emails, and real prod IDs. The commit hooks do
   not read PR titles, bodies, or attachments (`AGENTS.md` → "NEVER write customer data or
   PII"). Write the class instead: "a customer reported", `<session_id>`.
