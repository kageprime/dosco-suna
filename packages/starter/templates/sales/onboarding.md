## Sales Factory: the steps of this template

Run the guide below as written. This template adds five steps at the points
named here. The loop is one agent, `sales`, with one contract skill,
`sales-loop`, and six task skills. Its files are under `.kortix/sales/`: read
`skills/sales-loop/SKILL.md` once before you start, so you know the system of
record, the sources and the approval modes you set up.

Every **Ask** below is a question for the one message of guide step 3, with
its recommended answer. Never ask it where it appears.

### A. In guide steps 2 to 4: analyse the team, then sales.json

1. Run every check of
   `.kortix/sales/skills/sales-loop/references/analysis.md`: what the company
   sells, the connected connectors (`kortix connectors ls --json`), the env
   names, the signup handler in the code. Read only; never `cat` an env file.
2. **Ask** which system of record is the source of truth (analysis section
   2). Recommend the one the evidence shows; none: a JSON file in a new
   private repository, or a Google Sheet.
3. **Ask** for the ICP as one draft (analysis section 4): at most 4 lines,
   written from the website and the README. The person corrects it in their
   one reply.
4. **Ask** where drafts go (`approval.draft_in`: the Review page, the
   mailbox, the CRM) and whether the agent may move deal stages. Defaults:
   `review` and `notes`. Say plainly: the agent never sends a message.
5. Write `.kortix/sales/sales.json` (analysis section 6). Turn each chosen
   source's trigger on and every other source's trigger off in `sales.yaml`.

### B. After guide step 6: the system of record

1. **Attio, HubSpot, Salesforce or Pipedrive.** Install and connect it
   (`kortix connectors catalog install <app>`, then
   `kortix connectors connect <slug> --owner workspace` and give the person
   the sign-in link), or request the token by name with
   `kortix secrets request <NAME> --scope runtime` (`template.json` names
   each). Create the `kortix_lead_key`, `kortix_score` and `kortix_tier`
   fields as `references/records/<kind>.md` says; Salesforce fields need an
   admin. Run `record.context` once to prove access.
2. **JSON file.** `gh repo create <owner>/sales-ledger --private`, push a
   branch `ledger` with
   `{"version":1,"companies":{},"people":{},"deals":[],"notes":[],"tasks":[]}`
   as `leads.json`, and request `GH_TOKEN` with access to that repository
   only.
3. **Google Sheet.** Create the four tabs of
   `references/records/google-sheet.md`, share it with the team only, and
   install and connect the Google Sheets connector the same way.
4. `approval.outreach: approve_to_send` only: add this rule to the root
   `kortix.yaml`, then validate and push again. Without it the agent only
   drafts.

   ```yaml
   policies:
     - match: "gmail.send_*"
       action: require_approval
   ```

### C. After guide step 6: the webhook

1. `kortix onboard` (guide step 6) generated `SALES_WEBHOOK_SECRET`. Read the two URLs:
   `kortix triggers info sales-signup --json` and
   `kortix triggers info sales-inbound --json` (`webhook_url`).
2. **Ask** who adds the signup call to the product: you, as a pull request in
   the code repository, or the person. The call goes in the backend after the
   account exists, never in the browser: one `POST` to the signup URL with
   `Authorization: Bearer <secret>` and the payload of
   `references/sources/webhook.md`. The product keeps the secret in its own
   secret store, under a name the person chooses.
3. Inbound forms: give the person the inbound URL, the header and the
   payload. A form tool that cannot send a header posts through a relay the
   team already runs.
4. Optional sources: the sales inbox needs the Gmail connector and the
   workspace's event-trigger feature flag. CRM changes and meeting prep need
   `enabled: true` in both files; meeting prep also needs a calendar
   connector in `meeting_prep.calendar_connector`.

### D. Instead of the real run of guide step 7: prove one draft end to end

Synthetic data only. Never research or draft for a real person in the proof.

1. Post one synthetic signup, with an invented company on a reserved domain:

   ```sh
   curl -sS -X POST "$SIGNUP_URL" -H "Authorization: Bearer $SALES_WEBHOOK_SECRET" \
     -H 'Content-Type: application/json' \
     -d '{"kind":"signup","email":"sam@example.com","name":"Sam Example","company":"Example Inc","website":"https://example.com","plan":"free","source":"product"}'
   ```

2. `kortix triggers runs sales-signup` shows one run. Open its session with
   the person. The run line shows `leads=1` and `researched=1`. Research on
   `example.com` finds little, so the tier is `cold` and no draft is
   expected.
3. To see a draft, post one synthetic inbound lead with a message to the
   inbound URL (`"kind":"inbound"`, `"message":"We want a demo for our team
   of 40."`). The run submits a Review output `Draft: Example Inc (…)`. Show
   it to the person on the Review page.
4. With the person's OK, delete the synthetic records from the system of
   record (or the `example.com` entries of the JSON ledger).

### E. Add to the guide's step 9 report

- The system of record and its link; the enabled sources; the approval mode
  and where drafts appear.
- How to hand a lead over by hand: post the inbound payload, or ask the
  `sales` agent in a session.
- The caps from sales.json: leads researched per day, drafts per day.
- What the loop costs: each webhook trigger runs once per lead, hygiene once a
  week. Lower `max_runs_per_day` in `sales.yaml` to spend less.
