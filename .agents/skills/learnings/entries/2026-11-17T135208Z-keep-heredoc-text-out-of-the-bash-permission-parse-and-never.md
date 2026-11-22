---
recorded: 2026-11-17T13:52:08Z
incident_date: 2026-11-17
---
# Keep heredoc text out of the bash permission parse, and never silence a stray ask by removing an agent's rules: an unparsed line turns a deny into an ask

**Rule:** A heredoc body is code only when something on its line can run stdin. A command that ignores stdin (`cd`, `mkdir`, `echo`) never makes it code (`NEVER_RUNS_STDIN` in `harness/pi/interactions.ts`). When an agent asks for a call its rules allow, replay the exact command through `resolvePolicyRule` before you change anything. Never fix the ask by setting the agent's `permission` to `allow`: that deletes its hard denies.

**Trigger surface:** Changing `bashCommands`, `readsStdinAsCode` or `resolveRule` in `apps/kortix-sandbox-agent-server/src/harness/pi/interactions.ts`. Answering "the agent asks although its rules allow this".

**Incident:** 2026-11-17, prod, an internal agent with `kortix` bash rules. `cd /tmp; cat > body.md <<'EOF'` read the markdown as commands. An apostrophe left the line unparsed, and the `kortix` call after it matched a restricted rule's first word: the call waited 2 min 24 s for a person. On dev, the same shape before `kortix cr merge` (rule `deny`) became an approvable ask. A workaround change request set the agent to `permission: allow`, which removed its denies. Fixed in PR #12794.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/permission-precedence.test.ts`: "a markdown body after cd stays data under kortix rules" (allow, and `deny` for `kortix cr merge`), the `cd`/`mkdir`/`echo` data rows, and the trailing-pipe rows.
