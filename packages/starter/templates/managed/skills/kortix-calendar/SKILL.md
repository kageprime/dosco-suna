---
name: kortix-calendar
description: "The workspace's shared calendar for people and agents: items with a date, an owner and comments, beside the scheduled triggers and Loops. Use `kortix calendar` to put a dated item on the calendar, ask a person for something by assigning and @mentioning them, record a deadline, check what is due for you or for a person, and answer comments. Load when you need a person to act by a date, when someone asks what is coming up or what they owe, when you plan dated work, or when a message starts with [Calendar · <id>]."
metadata:
  kortix-feature-flag: calendar
---

<skill name="kortix-calendar">

<overview>
The calendar is one shared list of items for the whole workspace. Every person
and every agent sees and edits every item. An item has:

| Field | Meaning |
| --- | --- |
| title | one line: what is to be done or what happens |
| notes | the detail. `@handle` here notifies that person |
| when | a date and time, a date only (`--date`), or none ("No date") |
| owner | one person, one agent, or nobody |
| status | `open` or `done` |
| comments | a flat thread. `@handle` in a comment notifies that person |

The Calendar page also shows the scheduled triggers and Loops of the workspace.
They are not items: change them with `kortix triggers` and `kortix loops`.
</overview>

<when-to-use>
- You need a person to do something (approve, review, decide, send a file) by a
  date. Create an item, assign it to them, and @mention them in the notes.
- You commit to dated work: put it on the calendar with yourself as owner
  (`--assign me`), so people see it and can comment.
- Someone asks what is coming up, what is due, or what they owe: list the window.
- A message starts with `[Calendar · <id>]`: a person replied on an item you
  created. Read it with `kortix calendar show <id>` and continue the work.

Do not use the calendar for work an agent must start at a time by itself: that
is a trigger or a Loop (`kortix loops add`, `kortix triggers add`).
</when-to-use>

<commands>
```bash
kortix calendar people                         # @handles of people, and the agents
kortix calendar ls                             # today and the next 6 days, plus "No date"
kortix calendar ls --week --mine               # this week, owned by you (this agent)
kortix calendar ls --assignee ana-lima         # what one person owns
kortix calendar add "Approve the Q4 budget" --at "2026-11-20T15:00:00+01:00" \
  --assign ana-lima --notes "@ana-lima the draft is in Files at Finance/q4.md"
kortix calendar add "Launch post goes out" --date 2026-11-24 --assign me
kortix calendar show <id>                      # notes and comments
kortix calendar comment <id> "Done: the numbers are updated. @ana-lima"
kortix calendar edit <id> --at "tomorrow 10:00" --assign agent:writer
kortix calendar done <id>                      # or: reopen <id>
kortix calendar rm <id>
```
Add `--json` to any command for machine-readable output.

`<who>`: `me` (in a session: this agent), a person's `@handle` from
`kortix calendar people`, their email, or `agent:<name>`.

`<when>`: an ISO time with an offset (preferred: you know the person's time
zone from the conversation), `today 15:00`, `tomorrow 09:30`, or `in 2h`. A
time with no offset is the sandbox's time zone (usually UTC).
</commands>

<notifications>
- Someone else who @mentions a person, or assigns them an item, sends that
  person one notification: inbox and push now, email if it stays unread.
- Assigning a person notifies them. Mention them in the notes as well when you
  ask for something, so the notification says what you need.
- A person's comment on an item this session created, and a person marking it
  done or open again, arrives in this session as a message that starts with
  `[Calendar · <id>]`. Comments by agents wake nobody.
- Do not repeat a mention to chase someone. One item per ask; add a comment
  only when something changed.
</notifications>

<rules>
- Write the title as the outcome ("Approve the Q4 budget"), not "Task for Ana".
- Give an item a date only when it has one. "No date" is a valid place.
- Mark your own items done when they are done. Do not mark a person's item
  done for them unless they told you to.
- Everyone in the workspace reads the calendar. Put no secret into an item.
</rules>

</skill>
