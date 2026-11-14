# Source: the support mailbox (connector event)

Trigger `support-inbox` (connector event `GMAIL_NEW_GMAIL_MESSAGE` on the
`gmail` connector). Disabled by default.

Connector events are experimental and off by default: a workspace manager
turns them on in **Workspace admin** → **Feature flags** (`event_triggers`).
`kortix triggers events --connector gmail` lists the event types. Another mail
connector: change `connector` and `event` in support.yaml to the values that
command prints.

Without connector events, set `desk.kind: email` and turn on `support-queue`:
it reads the same mailbox every 15 minutes.

## Run

1. The event names one message. Read its thread through the mail connector
   (`references/desks/email.md`). Check the mailbox address first.
2. Drop without a note: mail from the mailbox itself, auto-replies, bounces,
   newsletters, vendor pitches. Count them as `skipped`.
3. Run contract §5 on the thread, with the email desk operations, whatever
   `desk.kind` says: the mailbox is where the customer wrote.
4. End with `support-inbox:` and the contract run line.
