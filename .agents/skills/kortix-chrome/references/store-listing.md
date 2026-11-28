# Chrome Web Store listing

The text of every field in the Chrome Web Store dashboard for the Kortix extension
(item `gefbbnjgoiljpbnalgafbhbfdhikgjek`, publisher "Kortix"). Paste it as written. When
`src/manifest.json` gains or loses a permission, change its justification here in the same
commit, and update the dashboard before the next upload.

The dashboard holds this text since 2026-10-13; 2026-11-18 added `contextMenus`, the side panel
parts of `scripting` and the host permission, User activity, and the privacy URL fix. Version
1.0.1, submitted 2026-11-18, passed review and went public on 2026-11-21. The Code column names
where each permission is used.

## Package

`bun run package` in `apps/chrome-extension` writes `release/kortix-chrome-<version>.zip`.
Dashboard → **Package** → **Upload new package**. The store accepts only a version higher than
the last upload.

## Store listing tab

| Field | Value |
|---|---|
| Name | `Kortix` (from the manifest) |
| Summary | `Let Kortix agents use this browser, with you watching.` (from the manifest) |
| Category | Workflow & Planning |
| Language | English |
| Store icon | `apps/chrome-extension/icons/128.png` |
| Screenshots | 5 × 1280 × 800, uploaded 2026-10-13 |
| Small promo tile | 440 × 280 "Kortix for Chrome", uploaded 2026-10-13 |
| Marquee promo tile | 1400 × 560, uploaded 2026-10-13 |
| Official URL | none |
| Homepage URL | `https://kortix.com` |
| Support URL | `https://kortix.com/support` (redirects to `/contact`; the store fetches it before it allows a submit) |

### Description

```text
Kortix connects this browser to your Kortix workspace. Ask any Kortix session to use your browser, and the agent works in it with the sites you are already signed in to: your inbox, your dashboards, your company tools.

While an agent works, you see:
• its tabs, with a glow around the page and the agent's cursor
• a bar on the page with Take over and Stop
• Kortix in Chrome's side panel, next to the page

You decide what it can do:
• Access: without asking, ask first, or off
• Tabs: all your tabs, or only the tabs it opens
• Stop ends a session's access at once

How it works: you sign in to Kortix once. Sessions run in Kortix's cloud and reach this browser through the extension. Nothing runs until a session asks, and only sessions you started can ask.

Requires a Kortix account (kortix.com).
```

## Privacy tab

### Single purpose

```text
Let the user's Kortix agent sessions operate this browser (open, read and act on web pages) on the user's request, with visible state on the page and a Stop control.
```

### Permission justifications

| Permission | Justification | Code |
|---|---|---|
| `debugger` | `Kortix agents open, read and click pages through the Chrome DevTools Protocol, only in the tabs a session the user started may use. Chrome shows its debugging notice while it is attached, and the user can stop it at any time.` | `background/shim.ts` |
| `tabs` | `List the user's open tabs when the user allows it, open and close the tabs a session uses, and follow their URL and title so the agent and the user see the same state.` | `background/shim.ts`, `hub.ts` |
| `tabGroups` | `Keep the tabs a session uses together in a named 'Kortix · <session>' tab group, so the user sees which tabs an agent works in.` | `background/attachment.ts` |
| `scripting` | `Draw the on-page glow, the agent cursor and the Take over / Stop bar in the tabs a session uses. When the user sends the current page from the side panel, read that page's text so the session can answer about it.` | `hub.ts` (`overlay.js`), `pages/sidepanel.ts` (`readPage`) |
| `storage` | `Keep the user's Kortix sign-in, the chosen Kortix server and the user's settings (access mode, tab scope) in the browser.` | `background/state.ts` |
| `alarms` | `Reconnect to Kortix after the network or the Kortix server restarts, so the browser stays available to the user's sessions.` | `background/index.ts` (`keepalive`, 30 s) |
| `sidePanel` | `Show Kortix in Chrome's side panel next to the page, so the user follows and steers the session while it works.` | `background/index.ts` |
| `contextMenus` | `Add "Ask Kortix about this page" and "Ask Kortix about this selection" to the right-click menu. Each opens the Kortix side panel with that page, or with the selected text as a quote, so the user can ask a session about it.` | `background/index.ts` |
| Host permission `<all_urls>` | `The agent works on the sites the user asks it to use, which can be any site, and the visible overlay (glow, cursor, Stop bar) must appear on any page a session uses. When the user sends the current tab from the side panel, the extension reads its text and, if the user asks, takes a screenshot of it; that tab can be any site.` | `pages/sidepanel.ts` (`captureVisibleTab`) |

### Remote code

`No, I am not using remote code.` Every script ships in the package. A session sends Chrome
DevTools Protocol commands as data through `chrome.debugger`. The extension loads no script
from the network and runs no `eval`.

### Data usage

Select:

- **Authentication information**: the OAuth tokens for the person's Kortix account.
- **Web history**: with "All tabs", a session sees the address and title of open tabs.
- **User activity**: while a session controls a tab, it can watch the page's network requests through the debugger.
- **Website content**: page text, screenshots and page data a session reads, and the page the person sends from the side panel.

Leave the others unselected. Tick all three certifications: no sale, no use unrelated to the
single purpose, no use for creditworthiness or lending.

Privacy policy URL: `https://kortix.com/legal?tab=privacy` (`/legal/privacy` is a 404). Its
section "Kortix in Chrome" (`#chrome-extension`) states what the extension keeps, what it sends
and the Limited Use statement. Change that section and this table together.

## Distribution tab

- Visibility: **Public**. Regions: all.
- Deferred publishing is off: an approved version goes live at once. Turn it on before you
  submit a version that needs a Kortix release first (for example a new API route), then select
  **Publish** after that release is live in prod.

## Test instructions tab

The reviewer signs in at kortix.com with a reviewer account. Every kortix.com project has Kortix in
Chrome (no feature flag since 2026-11-24). The credentials go into this tab only, never into git, Slack or a PR.

The reviewer account exists on prod since 2026-11-20: a password user with the Credits tier
(Kortix models need it), non-expiring credits, and a workspace named "Chrome review". A person
sets its password and pastes it here. To make another one: create the user with the Supabase admin
API (`email_confirm: true`, no password), sign in once with an admin magic link to create the
workspace (`POST /v1/projects/provision` with `new_workspace: true`), then use the admin API:
`POST /v1/admin/api/accounts/:id/tier` (`credits`) and `POST /v1/admin/api/accounts/:id/credits`.
After a test run, delete the test connection
(`DELETE /v1/chrome/connections/:id`) so the reviewer sees only their own browser.

```text
Email: <reviewer email>
Password: <reviewer password>

1. Install the extension. The welcome tab opens. Select "Connect to Kortix".
2. At kortix.com, enter the email, select "Use a password", enter the password and select Continue. Then select Allow.
3. Back on the welcome tab, keep the defaults and select Finish.
4. Open https://kortix.com. The workspace "Chrome review" opens.
5. In the message box, send: "Use my Chrome to open https://example.com and tell me the page title."
6. A tab group named after the session opens with example.com, and the bar at the bottom right shows "Kortix is working". The session answers with the title, "Example Domain".
7. To stop a session while it works, select Stop on the page, or press Alt+Shift+K. The session loses access to the browser.
8. Side panel: click the toolbar icon or press Alt+K, type a question about the current page, and send it.
```

## Graphic assets

| Asset | Size | Content |
|---|---|---|
| Store icon | 128 × 128 PNG | `icons/128.png` |
| Screenshots | 1280 × 800 | 5 in the dashboard (2026-10-13): "Your agents, in your browser", "Kortix next to the page", "You choose what it can do", "Stop any time", "Connect in one click" |
| Small promo tile | 440 × 280 | "Kortix for Chrome" with the working bar |
| Marquee promo tile | 1400 × 560 | "Your agents, in your browser." |
