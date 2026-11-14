# Source: the sales inbox

Trigger `sales-inbound-email`, a connector event: `GMAIL_NEW_GMAIL_MESSAGE` on
the `gmail` connector. Disabled by default. Connector events are a workspace
feature flag (**Workspace admin** → **Feature flags** → event triggers). Another
mail connector: list its event types with
`kortix triggers events --connector <slug>` and change `on.event` and
`on.connector` in sales.yaml. Setting: `sources.inbound-email.mailbox`, the
address of the shared sales inbox (never a person's private mailbox unless
that person set it up).

## Run

1. Check `sources.inbound-email.enabled`. Disabled: `errors=disabled`.
2. Read the message from the event payload. Need more (the thread, the body):
   read it with the connector's get-message tool. Never read other threads.
3. Classify in one pass: `lead` (a person asks about buying, pricing, a demo,
   a trial for a team), `customer` (an existing customer: hand to the record
   owner as a task, no draft), `vendor` (someone selling to you), `noise`
   (newsletters, notifications, auto-replies), `opt-out` (asks to stop).
4. `vendor` and `noise`: write nothing. `opt-out`: find the person, write
   `[sales-loop] skipped · opt-out` and set the record's do-not-contact field.
5. `lead`: run "One lead, end to end" (contract §5) with the sender's address
   and the message. The draft is a `reply` in the same thread: with
   `approval.draft_in: mailbox`, create it as a draft reply in that thread.
6. Never label, archive, move or delete a message. Never mark it read.
7. End with the run line, slug `sales-inbound-email`.
