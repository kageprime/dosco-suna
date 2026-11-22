---
name: support-answer-drafts
description: Draft the reply to one triaged support conversation from the docs and the codebase, with a source for every statement (a docs URL or a repository file and line), then deliver it as the category's approval mode says - a draft and a Review output by default. Load it for contract step 5 of the support-loop skill, or when a person asks for a reply draft.
---

# Support answer drafts

Input: one triaged conversation. Output: one draft, delivered per contract
§6, and one `[support-loop] draft` note. The `support-loop` contract rules
apply. Never send in `draft` mode.

## 1. Find the answer

In this order, and stop when the answer is complete:

1. **The docs.** Every entry of `knowledge.docs`: fetch the public URL, or
   search the repository path with `grep -rn`. Keep the exact URL with its
   anchor.
2. **The code.** Clone `knowledge.code_repo` read-only into
   `/tmp/support/code` (`gh repo clone <repo> /tmp/support/code -- --depth 1`).
   Find the route, the error message, the setting or the limit the customer
   met. Keep `file:line`. The code explains behavior; the reply never quotes
   code that is not public.
3. **Past answers.** The desk's last 30 days of `[support-loop] draft` notes
   in the same category and surface that a person sent unchanged. Never copy
   another customer's details.

No source answers it: the draft says a person will follow up, and the
confidence drops below the auto-reply bar.

## 2. Write the draft

- Answer the question in the first sentence.
- Then the steps, numbered, with the exact names of buttons, settings and
  commands as the docs and the code spell them.
- Link the docs page. Never link a repository file in a customer reply unless
  the repository is public.
- For a `bug`: say it is confirmed or being checked, give the workaround when
  one exists, and say a person will update them. Never promise a date.
- For `billing` and `account`: say what a person will do and by when the
  team usually answers only if support.json states it. Never say it is done.
- For a `feature-request`: thank them, say it is recorded, never promise it.
- The customer's language. Short sentences. No filler, no blame.
- End with `company.signature`.

## 3. Check

Before delivery, check every sentence against its source. A sentence with no
source is cut. A price, a date, a limit or a plan name that the docs do not
state is cut.

## 4. Deliver

Per `approval.categories.<category>` and contract §6:

- `draft`: `draft.create`, then
  `kortix review submit --kind output --title "Reply: <category> · <key>" --summary "<one line>" --risk <low|medium|high> --detail '{"preview":"<the draft>","sources":"<urls and file:line>"}'`.
- `approve_to_send`: the policy check of contract §6, then `reply.send`
  through the desk connector. The held call is the person's approval.
- `auto_reply`: every check of contract §6, then `reply.send`, re-read, the
  `[support-loop] sent` note, `conversation.mark_done`.

Then the note:

```
[support-loop] draft
<the draft>
Sources: <each URL or file:line>
support-key: <key>
```
