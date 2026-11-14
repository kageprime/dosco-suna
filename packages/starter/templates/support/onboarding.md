## Support Factory: the steps of this template

Run the guide below as written. This template adds five steps at the points
named here. The loop is one agent, `support`, with one contract skill,
`support-loop`, and five task skills. Its files are under `.kortix/support/`:
read `skills/support-loop/SKILL.md` once before you start, so you know the
desk, the sources and the approval modes you set up.

Every **Ask** below is a question for the one message of guide step 3, with
its recommended answer. Never ask it where it appears.

### A. In guide steps 2 to 4: analyse the team, then support.json

1. Run every check of
   `.kortix/support/skills/support-loop/references/analysis.md`: the connected
   connectors (`kortix connectors ls --json`), the env names
   (`kortix env push --from <file> --names --json`: `PLAIN_`, `INTERCOM_`,
   `ZENDESK_` prefixes), the README, the docs folder, a feedback widget in the
   code, and whether `.kortix/software-factory/factory.json` exists. Read
   only; never `cat` an env file, never open a customer conversation.
2. **Ask** which desk is the source of truth (analysis section 2). Recommend
   the one the evidence shows; none: a JSON file in a new private repository.
3. **Ask** where the docs live: the public docs URLs, and the repository and
   path of the help center (`knowledge`).
4. **Ask** for the approval mode per category (analysis section 3). Default
   and recommended to start: `draft` for every category. Say plainly: the
   agent never refunds, credits or changes an account, and a security report
   always goes to a person.
5. Write `.kortix/support/support.json` (analysis section 5). Turn each
   chosen source's trigger on and every other source's trigger off in
   `support.yaml`.
6. The Software Factory is in this repository: set its `source-support-inbox`
   trigger `enabled: false` in `factory.yaml` and
   `sources.support-inbox.enabled: false` in `factory.json`. This loop files
   the support defects into the same store; two producers would file each
   defect twice.

### B. After guide step 6: the desk

1. **Plain, Intercom or Zendesk.** Install and connect it
   (`kortix connectors catalog install <app>`, then
   `kortix connectors connect <slug> --owner workspace` and give the person
   the sign-in link), or request the token by name with
   `kortix secrets request <NAME> --scope runtime` (`template.json` names
   each). Do the desk setup writes of analysis section 6. Run `desk.context`
   once to prove access.
2. **Email.** Connect the mailbox's Gmail account the same way. Check the
   profile address equals `desk.mailbox`.
3. **JSON file.** `gh repo create <owner>/support-desk --private`, push a
   branch `desk` with `{"version":1,"cursor":null,"conversations":[]}` as
   `conversations.json`, and request `GH_TOKEN` with access to that
   repository only (and the help-center repository, for `support-docs-gaps`).
4. A category set to `approve_to_send`: add a rule for the desk's reply tool
   to the root `kortix.yaml`, then validate and push again. Read the tool
   name from `kortix connectors show <slug>`. Without the rule the agent only
   drafts.

   ```yaml
   policies:
     - match: "intercom.reply_*"
       action: require_approval
   ```

5. Slack: install and connect the Slack connector, write the shared channel
   ids into `sources.slack.channels`, and check that `notify.escalations`
   and `notify.digest` are internal channels, never shared ones.

### C. After guide step 6: the webhook

1. `kortix onboard` (guide step 6) generated `SUPPORT_WEBHOOK_SECRET`. Read the URL:
   `kortix triggers info support-feedback --json` (`webhook_url`).
2. **Ask** who adds the feedback call to the product: you, as a pull request
   in the code repository, or the person. The call goes in the backend, never
   in the browser: one `POST` with `Authorization: Bearer <secret>` and the
   payload of `references/sources/webhook.md`. The product keeps the secret
   in its own secret store and sends a customer reference, never an email.
3. The desk queue: Plain, Intercom and Zendesk sign their own webhooks with
   their own schemes, so `support-queue` polls every 15 minutes instead. Turn
   it on in both files when the desk is connected.
4. The mailbox event needs the workspace's `event_triggers` feature flag
   (**Workspace admin** → **Feature flags**). Without it, use `desk.kind:
   email` and `support-queue`.

### D. Instead of the real run of guide step 7: prove one draft end to end

Synthetic data only. Never open, answer or change a real conversation in the
proof. Nothing is sent to anybody.

1. Write one synthetic ticket yourself: an invented customer reference, a
   reserved domain, and a question the docs answer. Post it:

   ```sh
   curl -sS -X POST "$FEEDBACK_URL" -H "Authorization: Bearer $SUPPORT_WEBHOOK_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"kind":"feedback","id":"fb_proof_1","text":"How do I export a report to CSV?","surface":"reports","customer_ref":"cust_example_1","plan":"team","url":"https://app.example.com/reports"}'
   ```

   With the `json-file` desk you may instead append the same ticket to
   `conversations.json` and run `kortix triggers fire support-queue --wait 300s`.
2. `kortix triggers runs support-feedback` shows one run. Open its session
   with the person. The run line shows `triaged=1` and `drafted=1`.
3. Open the Review page with the person: the item
   `Feedback: how-to · feedback:fb_proof_1` holds the triage line, the draft
   and its sources (docs URLs or `file:line`). Check that every sentence has
   a source.
4. With the person's OK, dismiss the item
   (`kortix review act <item> dismiss`) and remove the synthetic conversation
   from the JSON desk.

### E. Add to the guide's step 9 report

- The desk and its link; the enabled sources with their schedules; the
  approval mode per category and where drafts appear.
- Where bugs go: the Software Factory's store, GitHub issues labeled
  `support-bug`, or the Review page.
- The caps from support.json: conversations per run, drafts per day, bug
  tickets per day.
- What the loop costs: the queue runs every 15 minutes, one short turn when
  nothing changed; clustering once a week. Change `support-queue`'s `cron`
  to run less often.
