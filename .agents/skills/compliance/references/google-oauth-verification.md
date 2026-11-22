# Google OAuth verification of the Kortix Google connectors

Gmail, Google Calendar, Google Drive, Google Docs and Google Sheets connect
through Kortix's own Google OAuth client (`apps/api/src/connectors/google/`,
`KORTIX_OAUTH_CLIENTS.google`). Google lets that client serve more than test
users only after it verifies the GCP project. The project requests restricted
scopes, so Google also requires a CASA security assessment **every 12
months**. This file is the procedure, the text we submitted, and the
obligations that keep the approval valid.

## Projects and clients

| GCP project | Audience | Clients | Used by |
| --- | --- | --- | --- |
| `kortix-connectors` (#342665293767) | External. Goes through verification and CASA | "Kortix prod + staging" (one client, so the demo video shows one client ID; redirects `api.kortix.com` and `staging-api.kortix.com`) | prod, staging |
| `kortix-connectors-dev` | Internal (kortix.ai accounts only). Never verified | "Kortix local", "Kortix dev" | local, dev |
| `kortix` | Sign in with Google only. Branding verified, no data scopes | — | Kortix sign-in. Do not add data scopes here |

Organization: kortix.ai. Console: Google Auth Platform → Branding, Audience,
Data Access, Verification Center (`console.cloud.google.com/auth/...?project=<id>`).

A deployment uses a client only when its `KORTIX_OAUTH_CLIENTS` (the AWS
Secrets Manager blob, `.env.<env>` locally) has a `google` entry. Without it,
Composio's Google toolkits stay in the catalog. Never add the `kortix-connectors`
client to the prod blob before Google approves: users outside the test list
cannot sign in, and an unverified app shows a warning and has a lifetime cap of
100 users.

## Scopes and justifications

Paste these into Data Access → each scope's justification. Change a tool that
needs a new scope only after you add the scope here, to the privacy policy
(`/legal?tab=privacy#google-user-data`) and to the Data Access page. A new
sensitive or restricted scope starts a new verification.

| Scope | Class | Justification |
| --- | --- | --- |
| `openid`, `userinfo.email`, `userinfo.profile` | non-sensitive | Shows which Google account a connection uses ("Connected as"). |
| `gmail.modify` | restricted | A Kortix agent reads, searches, drafts, sends, replies to, forwards, labels, archives and trashes email when the user asks, and a Gmail trigger reads new messages that match the user's filter to start the user's automation. `gmail.readonly` cannot send, label or trash. `gmail.send` and `gmail.compose` cannot read. `gmail.metadata` has no message bodies. `gmail.modify` is the narrowest scope that reads and organizes mail. We do not request `https://mail.google.com/`: delete tools move mail to Trash. |
| `gmail.settings.basic` | restricted | The agent creates, reads and deletes Gmail filters when the user asks (for example "label every invoice from this sender"). Filters need this scope. We do not request `gmail.settings.sharing`. |
| `contacts.readonly` | sensitive | The agent finds a recipient's address by name in the user's saved contacts before it writes an email ("email Ana the report"). |
| `contacts.other.readonly` | sensitive | The same lookup over "Other contacts": the people the user emailed but did not save, who are most recipients. |
| `calendar` | sensitive | The agent lists, creates, changes and deletes events, finds free time across the user's calendars, creates and shares calendars, and changes calendar access lists when the user asks. `calendar.events` cannot create calendars or change sharing. |
| `drive` | restricted | The agent searches, reads, exports, uploads, moves, comments on and shares any file the user names, including files Kortix did not create. The Docs and Sheets connectors use it to find documents by name and export them. `drive.file` covers only files the app created or the user picked, and an agent works on the user's existing files by search. `drive.readonly` cannot write. |
| `documents` | sensitive | The agent reads, creates and edits Google Docs, including a document built from Markdown. |
| `spreadsheets` | sensitive | The agent reads and writes cell values, formulas and formatting, and creates spreadsheets. |

## Requirements Google checks

- **Branding.** App name "Kortix", logo, home page `https://kortix.com/`,
  privacy policy `https://kortix.com/legal?tab=privacy`, terms
  `https://kortix.com/legal?tab=terms`, authorized domain `kortix.com`. Use
  `kortix.com`, not `www.kortix.com`: `www` redirects, and Google's checker
  must not follow a redirect. A
  project Owner or Editor must be a verified owner of `kortix.com` in Google
  Search Console. The project Owner is verified through a TXT record on
  `kortix.com` in Cloudflare (`google-site-verification=p3mL…`, comment
  "Search Console: Google OAuth verification of kortix-connectors"). Do not
  delete that record: the verification ends with it. Branding cannot change
  while a review runs.
- **Privacy policy.** The section "Google user data" (`#google-user-data` in
  `apps/web/src/app/[locale]/(public)/(seo)/legal/page.tsx`) states what we
  access, use, store, share and delete, and carries Google's Limited Use
  sentence. It must be live on www.kortix.com before submission.
- **Demo video.** One unlisted YouTube video, English consent screen. For each
  of the five connectors: the sign-in, the consent screen with the app name,
  the address bar with the client ID, then the agent using each scope and the
  result in Google's own UI. When the project has two clients, the video shows
  data access through each. Record one browser window, not a screen region: a
  region records whatever window is on top (2026-11-20, a teammate kept
  working and the take showed Slack, terminals and a customer dashboard).
  What worked: a separate Chrome (`--user-data-dir` scratch profile,
  `--remote-debugging-port`, `--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding`) driven with `agent-browser --cdp`, and a
  ScreenCaptureKit window capture of it, which keeps recording while other
  windows cover it. Sign that profile in to Google with the kortix.ai test
  account only, so the account chooser shows no personal address.
- **Publishing status.** Audience → "In production" before Verification
  Center → "Prepare for verification".
- **Brand before data access.** Branding → "Verify branding" runs an automated
  check (minutes), then "Publish branding" (within 7 days, or the result
  expires). The data-access request stays locked until branding is published.
- **Data Access page.** One justification for the sensitive scopes, one for
  Drive and one for Gmail (1,000 characters each, text as in the table above),
  the features "Drive productivity" and "Email productivity", and the video
  link. Save stores them; Verification Center → "Prepare for verification"
  submits.
- **CASA.** Restricted scopes need an App Defense Alliance CASA assessment by
  an authorized lab (TAC Security lists Tier 2 at $540–$720 per app per year).
  The lab issues a Letter of Assessment to Google. Repeat at least every 12
  months after its date: Google emails the developer contacts.

## Timeline Google states

| Step | Google's figure |
| --- | --- |
| Brand verification | 2–3 business days |
| Sensitive scopes | up to 10 days |
| Restricted scopes | "several weeks" |
| CASA Tier 2 at a lab | 1–3 weeks, plus fixes for its findings |

## Obligations while the approval is valid

- Use Google user data only for features the user sees and asks for. Never
  for ads, never sold, never to train generalized AI or ML models.
- Staff read Google user data only with the customer's explicit consent for
  specific data, for security (abuse), for legal compliance, or aggregated and
  anonymized. An act-as grant ("Open as admin", see SKILL.md) into an account
  with a Google connector needs a customer request or a security or legal
  reason, and the audit log records it.
- Disconnect deletes the stored token. It revokes the grant at Google when the
  account's last live Kortix Google connection goes (`revokeConnectionOAuth2`,
  `apps/api/src/connectors/oauth2-store.ts`): Google keeps one grant per
  account for our client, so revoking it while another connection of the same
  account is live breaks that connection too. Keep the last-connection revoke.
- Keep the developer contacts on Branding current. Google sends recertification
  and policy notices there.

## Status log

Newest first. Add a line for every submission, Google email, CASA step and
recertification.

- 2026-11-20: submitted. Verification Center: "Your app's data access is
  under review." Demo video: unlisted on the Kortix YouTube channel, "Kortix:
  Google OAuth verification demo (project kortix-connectors)", 16:52, recorded
  on staging with the one client. Questionnaire: not personal, not internal,
  not testing-only, not a WordPress plugin; acknowledged the requirements and
  CASA. Next: answer Google's emails; start CASA Tier 2 when Google asks for
  it.
- 2026-11-20: found while recording: disconnecting Drive revoked the
  account's whole grant and Calendar failed with `credential_rejected` (401).
  Fixed in #12957 (disconnect revokes only the
  account's last connection).
- 2026-11-19: v0.16.0 live in prod. The privacy section is live on
  kortix.com. Staging's Secrets Manager blob has the Google client
  (2026-11-18). Prod's blob has none until Google approves.
- 2026-11-18: project "In production" (0 of 100 unverified users). Branding
  verified and published. Scope justifications and features saved on Data
  Access. Left: the demo video on staging after the next release, then submit
  once the privacy section is live on kortix.com.
- 2026-11-18: "Kortix staging" client deleted (restorable until 2026-12-18);
  "Kortix prod + staging" serves both. `apps/api/.env.staging` uses it.
- 2026-11-18: Search Console Domain property `kortix.com` verified for the
  project Owner (TXT record in Cloudflare).
- 2026-11-18: privacy section "Google user data" merged to `dev` (#12810).
  Reaches www.kortix.com with the next release. Project still "Testing". Not
  submitted.
