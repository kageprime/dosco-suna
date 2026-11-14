## Recruiting Factory: the steps of this template

Run the guide below as written. This template adds five steps at the points
named here. The loop is one agent, `recruiting`, with one contract skill,
`recruiting-loop`, and six task skills. Its files are under
`.kortix/recruiting/`: read `skills/recruiting-loop/SKILL.md` once before you
start, so you know the fairness rules, the system of record, the sources and
the approval modes you set up.

Every **Ask** below is a question for the one message of guide step 3, with
its recommended answer. Never ask it where it appears.

### A. In guide steps 2 to 4: analyse the team, then recruiting.json

1. Run every check of
   `.kortix/recruiting/skills/recruiting-loop/references/analysis.md`: the
   connected connectors (`kortix connectors ls --json`), the env names
   (`kortix env push --from <file> --names --json`), the README and any
   careers form handler in the code, the public careers page. Read only;
   never `cat` an env file, never open a real candidate's data.
2. **Ask** which ATS is the source of truth (analysis section 2). Recommend
   the one the evidence shows; none: a JSON file in a new private repository.
3. **Ask** for the open roles' rubrics as drafts, all roles in one question
   (analysis section 3): one line per role from its public job post, with the
   must-haves and the top signals. The person corrects them in their one
   reply. Write the full rubric (signals and weights, knockout questions
   that are job-related only, the interview plan) in guide step 4, and read
   it back against the fairness rules (contract §1 rules 3 and 4) first.
4. **Ask** where drafts go (`approval.draft_in`: the Review page, the
   mailbox, the record) and the retention period (`retention_days`, default
   180). Say plainly: a person decides every advance and every reject, and
   the agent never sends a message.
5. Write `.kortix/recruiting/recruiting.json` (analysis section 5). Turn each
   chosen source's trigger on and every other source's trigger off in
   `recruiting.yaml`.

### B. After guide step 6: the system of record

1. **Ashby, Greenhouse, Lever or Workable.** Install and connect it
   (`kortix connectors catalog install <app>`, then
   `kortix connectors connect <slug> --owner workspace` and give the person
   the sign-in link), or request the key by name with
   `kortix secrets request <NAME> --scope runtime` (`template.json` names
   each). Ask for a key with read access to jobs, candidates and
   applications and write access to notes only. Run `record.context` once to
   prove access, then `job.list()` and write each `ats_job_id`.
2. **JSON file.** `gh repo create <owner>/hiring-ledger --private`, push a
   branch `ledger` with `{"version":1,"candidates":{}}` as `candidates.json`,
   and request `GH_TOKEN` with access to that repository only. Check
   `gh repo view <owner>/hiring-ledger --json visibility` reads `PRIVATE`.
3. `approval.messages: approve_to_send` only: add this rule to the root
   `kortix.yaml`, then validate and push again. Without it the agent only
   drafts.

   ```yaml
   policies:
     - match: "gmail.send_*"
       action: require_approval
   ```

### C. After guide step 6: the webhook

1. `kortix onboard` (guide step 6) generated `RECRUITING_WEBHOOK_SECRET`. Read the two URLs:
   `kortix triggers info recruiting-applicant --json` and
   `kortix triggers info recruiting-referral --json` (`webhook_url`).
2. **Ask** who adds the call to the careers form's backend: you, as a pull
   request in the code repository, or the person. The call goes in the
   backend after the application is stored, never in the browser: one
   `POST` with `Authorization: Bearer <secret>` and the payload of
   `references/sources/webhook.md`. The form keeps the secret in its own
   secret store, under a name the person chooses.
3. Referrals: give the person the referral URL, the header and the payload,
   for the referral form or a Slack workflow the team already runs.
4. An ATS as the only source: its own webhooks sign with their own scheme.
   Turn on `recruiting-ats-poll` in both files instead, unless the ATS's
   webhook settings let a person set the `Authorization: Bearer` header.
5. Optional: the jobs inbox needs the Gmail connector and the workspace's
   event-trigger feature flag (**Workspace admin** → **Feature flags**).
   Sourcing needs `sourcing.enabled: true` and approved `sourcing.queries`
   per role, and `enabled: true` on `recruiting-sourcing`.

### D. Instead of the real run of guide step 7: prove one screen end to end

Synthetic data only. Never screen or draft for a real person in the proof.

1. Write one synthetic CV for a fictional candidate for one open role: the
   name `Sam Example`, the email `sam@example.com`, an invented employer, and
   3 to 5 lines of work history that meet some of the role's must-haves and
   miss one. Say to the person that the candidate is fictional.
2. Post it to the applicant URL:

   ```sh
   curl -sS -X POST "$APPLICANT_URL" -H "Authorization: Bearer $RECRUITING_WEBHOOK_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"kind":"application","role":"<role id>","candidate":{"name":"Sam Example","email":"sam@example.com","resume_text":"<the synthetic CV>"},"answers":[],"submitted_at":"<now, ISO>"}'
   ```

3. `kortix triggers runs recruiting-applicant` shows one run. Open its
   session with the person. The run line shows `screened=1` and
   `decisions_requested=1`. The candidate is not in the ATS, so nothing is
   written there: the scorecard is in the Review `decision` item. With the
   json-file record, the ledger holds one `cand:…:<role id>` entry.
4. Show the person the Review item: the scorecard, each score with its
   quote, the recommendation, "Not assessed: protected attributes …".
5. Answer it on the Review page with `reject`, wait for the next
   `recruiting-decisions` pass (or `kortix triggers fire recruiting-decisions --wait 300s`):
   a `hold` is recorded and no draft is made. That proves a person's verdict
   drives the loop.
6. Delete the synthetic entry from the JSON ledger, and dismiss the Review
   item.

### E. Add to the guide's step 9 report

- The system of record and its link; the enabled sources; the approval mode
  and where drafts appear; the retention period.
- How a person decides: answer each `Advance or reject: …` item on the
  Review page; the loop drafts the next message within the hour, on
  business days.
- The fairness rules in one line: a structured rubric per role, evidence for
  every score, no protected attributes, a person decides every step.
- The caps from recruiting.json: screens per day, drafts per day.
- What the loop costs: each webhook trigger runs once per application, the
  decisions pass up to 11 times a business day, hygiene once a week. Lower
  `max_runs_per_day` in `recruiting.yaml` to spend less.
