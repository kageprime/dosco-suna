---
recorded: 2026-11-16T18:21:40Z
incident_date: 2026-11-16
---
# Give a factory test run a token scoped to the test repository, never the machine's gh login token

**Rule:** When a test run of a factory template needs `FACTORY_GITHUB_TOKEN`, mint a fine-grained token that reaches only the test repository and store it with `kortix secrets set FACTORY_GITHUB_TOKEN=-`. Never pipe `gh auth token` into a workspace secret that is delivered to sandboxes. Say so in the brief of any agent that runs the setup for you.

**Trigger surface:** Running the setup guide or a factory template end to end on a local stack, dev or a preview: any step that fills a GitHub token secret with `delivery: sandbox`.

**Incident:** 2026-11-16, a from-zero run of the Software Factory setup on a local worktree stack. The agent that played the person stored the machine's `gh` login token (scopes `admin:org`, `gist`, `repo`, `workflow`) as `FACTORY_GITHUB_TOKEN`. For about 30 minutes it was in the environment of 8 cloud sandboxes that ran model-driven agents. The secret was unset and the 8 sessions were deleted the same hour; a deleted session's disk stays restorable for 30 days, so the cleanup does not end the exposure: only rotating the token does, and that was handed to its owner. No misuse was observed. The brief for the run named the test repository and the account but did not name the token to use.

**Enforcement:** none yet: `kortix secrets set` and `kortix onboard --github-token` could refuse a token whose scopes include `admin:org` or that is not fine-grained, unless `--allow-broad-token` is passed.
