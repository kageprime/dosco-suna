---
name: qualiloop
description: "QualiLoop tests and traces the My Kortix agent from outside: it chats with it through POST /v1/qualiloop/chat on dev, reads each turn's trace, and judges the replies. Load WHENEVER you run, read or change QualiLoop tests, suites, problems or checks (`npx qualiloop ...`); touch apps/api/src/qualiloop or apps/api/src/projects/qualiloop; or change a system prompt, a tool or a managed skill of the agent, since QualiLoop's system knowledge must then be sent again."
---

# QualiLoop

QualiLoop (app.qualiloop.com) is an external test harness for AI agents. It
sends the agent messages as a simulated user, reads the agent's trace, and
judges each conversation against the agent's system knowledge. Kortix is
QualiLoop project **#1 "Kortix AI Corp"**.

## How it reaches the agent

| Piece | Where |
|---|---|
| Endpoint | `POST /v1/qualiloop/chat` (`apps/api/src/qualiloop/index.ts`): `{prompt, metadata.session_id, metadata.turn_index}` in, `{"reply"}` out, `X-Agent-Secret` checked in constant time |
| Turn | `apps/api/src/projects/qualiloop/turn.ts`: one QualiLoop conversation = one Kortix session (id = a hash of the conversation id), started or continued through the normal session lifecycle as the project's owner, source `qualiloop` (origin `user`: the owner's own private chat, with Drive and memory) |
| Trace | `apps/api/src/projects/qualiloop/spans.ts`: after the turn, the session log becomes one OTLP/JSON trace (turn span, a `chat` span per model call with the system prompt and tokens, an `execute_tool` span per tool call), sent before the reply returns |
| Retries | each `turn_index` claims its turn once (`qualiloop_turns` in the session's metadata): a resent turn after a network failure waits for the same answer and never sends the prompt twice |
| Reply | the turn is answered when its prompt is in the session log and no turn is open. A prompt sent while a turn runs (a colleague's report woke the session) joins that turn, and the reply is that turn's text |
| Keep-alive | the route answers `200` at once and sends a space every 15 s until the JSON: Cloudflare cuts a response whose first byte takes over 100 s, and a turn with a sandbox boot can take minutes |

The route answers `404` unless both `QUALILOOP_AGENT_SECRET` and
`QUALILOOP_KORTIX_PROJECT_ID` are set. Only test turns are traced: real users'
sessions send QualiLoop nothing, and live traffic is off. Turning live traffic
on sends customer data to QualiLoop, which makes it a subprocessor: that needs
the **compliance** skill first.

## Where it runs

Only **dev** is configured (`https://dev-api.kortix.com/v1/qualiloop/chat`).
The test sessions run in the project "QualiLoop tests" of a synthetic test
account on dev. Its password is in the macOS Keychain of the machine that set
it up (`kortix/QUALILOOP_DEV_TEST_PASSWORD`), and the endpoint secret in
`kortix/QUALILOOP_AGENT_SECRET_DEV`. The four variables live in the AWS Secrets
Manager blob `kortix-dev-env` (us-east-2), mirrored in `apps/api/.env.dev`:

| Variable | Value |
|---|---|
| `QUALILOOP_AGENT_SECRET` | the secret QualiLoop sends as `X-Agent-Secret` (saved on QualiLoop's side with the target) |
| `QUALILOOP_KORTIX_PROJECT_ID` | the Kortix project the test sessions run in |
| `QUALILOOP_PROJECT_KEY` | QualiLoop's project key: `npx qualiloop connect env --file <file>` writes it |
| `QUALILOOP_OTLP_TRACES_URL` | QualiLoop's traces address, written by the same command |

Staging and prod stay unconfigured: leave the secret unset there.

- ECS reads `kortix-dev-env` when a task starts. After you change it, roll the
  API service (`aws ecs update-service --cluster kortix-dev-use2 --service
  kortix-dev-use2 --force-new-deployment`, region us-east-2, `kortix-mfa`
  profile) and wait until the route answers `401` without the secret.
- The test account is on the Credits plan with granted credits (admin routes
  `POST /v1/admin/api/accounts/{id}/tier` and `/credits`). On the Free plan
  every turn ends `{"error":"No model: upgrade to the Credits plan or add your
  own provider key."}`. A low balance does the same: grant more.
- QualiLoop saves the target with `max_parallel_conversations` 4 (each
  conversation is one sandbox, and its hand-offs start more) and
  `reply_timeout_seconds` 600. At 8, dev's sandbox provider ran out of room
  (`503 capacity`) and sessions never started. The route
  gives up on a turn after 570 s, so QualiLoop always gets an answer first.

## Run tests

`npx qualiloop ...` from any folder, signed in with `npx qualiloop login`
(a browser approval). Every command names the project it acted on: check it is #1.

1. Reset the test project. Test conversations make real things (agents,
   skills, crons, reminders, Apps, connectors, secrets, Drive files, memory,
   artifacts, invites). Left behind, crons fire and spend, and the next test
   sees another workspace. As the test account:
   `KORTIX_TOKEN=<access token> QUALILOOP_KORTIX_PROJECT_ID=<id> .agents/skills/qualiloop/scripts/reset.sh`.
   It deletes them, puts the repository back to the tag `qualiloop-baseline`
   (the tree the project had when it was created; set it once with `git tag`
   and `git push origin qualiloop-baseline` on a new test project) and exits
   `1` when anything is left. It refuses while a QualiLoop run is open (a
   reset then deletes the sessions of conversations still running), or when
   the QualiLoop CLI cannot say, for example after its sign-in expired.
2. `npx qualiloop connect check`: one real turn plus its trace. Every required
   item passes, or the endpoint, the deploy or a variable is broken.
3. `npx qualiloop suites run core --wait --fail-on major`: the Core suite
   (26 tests, one or two per area). `suites run "My Kortix e2e"` is the deep
   one (86 tests in 14 areas: first contact, delegation, agents, skills,
   connectors, secrets, models, follow-through, automations, goals, files and
   memory, people and billing, sessions, red team), about 2 hours at 4 at a
   time. `suites run "Workspace configuration"` (78 long conversations) covers
   setting a workspace up from the chat. Reset between suites. One conversation is one conversation credit
   on QualiLoop, and one sandbox plus model use on the dev test account.
4. `npx qualiloop problems categories`, then the failed runs' problems: what to fix.
5. One run proves little: the same tests on the same model gave 19 major
   problems, then 7. Compare a change on 3 runs of the tests it touches.
6. To cover something new: `npx qualiloop generate "<what to test>" --suite core --wait`.
   QualiLoop writes the tests; do not write them by hand. Run `reset.sh` again
   after every run.

`npx qualiloop guide` prints QualiLoop's own loop for working on an agent.

## Send the system knowledge

QualiLoop judges every reply against the agent's system prompt, tools and
documents. Send them again after any change to a prompt
(`apps/kortix-sandbox-agent-server/src/harness/pi/`,
`apps/api/src/projects/lib/my-kortix-prompt.ts`), a tool, or a managed skill,
once that change runs on dev:

1. Save the system message of a fresh QualiLoop test session to a file: read
   the session's log (`GET /v1/projects/<project_id>/sessions/<session_id>/log?limit=100`
   as the test account) and keep the text of the first `role: system` message.
   The session's id is the `kortix.session_id` attribute of its turn span.
2. `bun .agents/skills/qualiloop/scripts/knowledge.ts <file> > knowledge.json`.
   The script replaces the session and project ids with placeholders and
   builds the tools and documents from the code. It fails when the prompt
   registers a tool it does not build: add that tool to the script.
3. `npx qualiloop connect knowledge --file knowledge.json`, then delete the file.
   Every source reads `new`, `unchanged` or `new version`; `skipped` names
   what to fix.
4. `npx qualiloop connect check`: `prompts_seen` passes and
   `unmatched_prompts` is empty.

## Disconnect

Unset `QUALILOOP_AGENT_SECRET` in `kortix-dev-env` (the route then answers
`404`), then run `npx qualiloop connect disconnect`. The project, its tests and
its knowledge stay in QualiLoop until someone deletes the project in its
Settings.
