# Source: the jobs inbox

Trigger `recruiting-inbox` (connector event `GMAIL_NEW_GMAIL_MESSAGE` on the
`gmail` connector). Disabled by default. Connector events are experimental
and off for a workspace until a person turns on `event_triggers` in
**Workspace admin** → **Feature flags**. `kortix triggers events --connector gmail`
lists the event types; another mail connector uses its own type.

Settings: `sources.inbox.connector`, `sources.inbox.mailbox` (the jobs
address, for example `jobs@example.com`).

## Run

1. The event names one message. Read it with the mail connector's read tool.
   It is not addressed to `sources.inbox.mailbox`: end with
   `errors=none skipped=1`.
2. Classify: an application (a CV attached or a role named), a candidate's
   question or reply about an application, a recruiter or agency pitch, a
   data request ("delete my data"), noise. Only an application continues.
   A candidate's reply: add a note to the candidate's record when the key is
   found, and submit a Review `output` with a reply draft
   (`recruiting-candidate-updates`, kind `answer`). A data request: a Review
   `decision` at once (contract §8). Agency pitches and noise: nothing.
3. Map the application to a role by the role title or id in the subject or
   body. No match: contract §5 step 1.
4. Extract the CV text from the attachment (`pdftotext`, or the text of a
   `.docx`) into `/tmp/recruiting/`. Run contract §5 from step 2 with the
   sender's address as the email.
5. Never reply to the message, never label, move or delete it. A person
   replies after the decision.
6. Delete the files under `/tmp/recruiting/`.
7. End with `recruiting-inbox:` and the contract run line.
