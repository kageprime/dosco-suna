---
recorded: 2026-11-11T23:24:10Z
incident_date: 2026-11-11
supersedes: 2026-09-30T115330Z-a-credential-shared-by-several-projects-needs-a-per-project.md
---
# Give one Slack workspace's shared-app token to exactly one Kortix workspace, and check that link before every Slack read or write

**Rule:** One Slack workspace is linked to one Kortix workspace on the shared Slack app (`channels/slack/link.ts`). An install moves the link and detaches the other installs (`moveSlackLink`); routing heals any older duplicates (`linkedSlackProject`); every Slack connector read and write first checks that the calling Kortix workspace holds the link (`slackProjectLink`, `slackLinkState`). Never fan the shared bot token out to a second Kortix workspace again, and never re-add per-channel ownership (`chat_channel_bindings` as a permission) for Slack: a channel row holds settings only. Private Slack content follows the person: a read of a private channel, group DM or DM needs the session's person in it (`connectors/slack-visibility.ts`). What changed: Slack no longer shares one token across Kortix workspaces, so its per-channel and per-thread ownership gates are gone; the superseded per-project rule still holds for Teams, which shares one Graph token per tenant.

**Trigger surface:** The Slack install and OAuth completion (`slack-oauth.ts`, `slack/installs.ts`), Slack event routing (`slack/dispatch.ts`, `slack/routes.ts`), the Slack connector gates (`connectors/slack-visibility.ts`, `connectors/channel-write-scope.ts`), the file proxy, and any code that loads a Slack token for a project.

**Incident:** 2026-11-11 redesign, not an outage. Prod had 102 Slack workspaces installed; 4 held 2 to 7 Kortix workspaces on one shared token, which required the 2026-09-30 per-channel ownership gates, a workspace picker, and cross-workspace thread routing. 54 of 58 Slack sessions in 30 days ran in one of those 4, through 1 Kortix workspace. The ownership model blocked agents from reading or joining channels their own rules allowed.

**Enforcement:** `channels/slack/link.integration.test.ts` (move, heal by usage, own app beside the shared one, channel row takeover, email linking), `__tests__/integration-channel-write-scope.test.ts` (the detached workspace writes nothing on real rows), `connectors/slack-visibility.test.ts` and `__tests__/unit-connector-channel-read-scope.test.ts` (not-linked and private reads denied before the credential and the provider).
