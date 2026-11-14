# Source: Slack shared channels

Trigger `support-slack` (cron, every 15 minutes, keyed session). Disabled by
default. Setting: `sources.slack.channels`, a list of channel ids (Slack
Connect channels shared with customers, or an internal `#support` channel).

## Access

The `slack` connector: `kortix connectors show slack` once per session for
the tool names (channel history, thread replies), then
`kortix connectors call slack <tool> '<json>' --json`. Read only.

**Never post into a shared channel.** A customer reads every message there.
The agent writes nothing in Slack except one line to `notify.escalations` and
`notify.digest` when support.json names them, and those must be internal
channels: setup checks that neither is in `sources.slack.channels`.

## Cursor

The newest message `ts` handled per channel, kept in the keyed session and
recovered as in `queue-poll.md`: the newest successful run's start time minus
15 minutes. The `slack:<channel id>:<thread ts>` key and the Review items
skip what was already done.

## Run

1. Read each channel's messages since the cursor into a file. Keep top-level
   messages and threads with a new customer message. Drop joins, bots, the
   team's own messages and emoji-only replies.
2. Run contract §5 on each thread with these changes: the triage and the
   draft go on a Review output (title `Slack: <category> · <slack key>`), not
   into Slack. A person answers in the thread. Every category is `draft`
   here, whatever `approval.categories` says.
3. Defects go through `support-bug-handoff` as usual.
4. End with `support-slack:` and the contract run line.
