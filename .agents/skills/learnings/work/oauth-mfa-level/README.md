---
title: "Sign in with Kortix" tokens in workspaces that require MFA
status: closed, not needed (2026-11-11). Reproduced on dev: only OAuth grants made before v0.15.3 are affected; reconnecting fixes them. The App viewer half shipped in #12423.
owner: unassigned
updated: 2026-11-11
---

# "Sign in with Kortix" tokens carry no MFA level

## Closed: what the dev reproduction showed (2026-11-11)

Driven on dev with a real TOTP aal2 session and the real MCP sign-in (register, PKCE authorize, consent, token):

- **A workspace-bound token passes the MFA gate.** Since #11857 (v0.15.3) the consent page binds every grant except the Chrome extension's to one workspace, and binding runs the workspace's MFA gate (`consentWorkspace` → `authorize`): a session without the second factor gets `403 workspace_not_found`. The bound token then gets a synthetic token id (`oauth-workspace:<id>`, `actingTokenBinding` in `apps/api/src/iam/actor.ts`), so `mfaGateBlocks` skips it like a workspace key. `GET /v1/workspaces/:id` → `200` with MFA on.
- **The Kortix in Chrome extension is not affected.** Its token is unbound, but it calls only `/v1/chrome/*`, which runs no account gate: `GET /v1/chrome/connections` → `200` with MFA on.
- **Only unbound grants made before v0.15.3 get `403 account_mfa_required`** in an MFA workspace. Reconnecting the client binds a new grant to a workspace.

The design below is kept for reference; build it only if old unbound grants must keep working without a reconnect.

The same reproduction found the real bug: `/v1/mcp` refused every workspace-bound token (`403 credential_fence_refused`, `person-route`), so no MCP client that signed in since v0.15.3 could use Kortix MCP. Fixed by binding `/v1/mcp` to the credential's own workspace (ledger: "Drive an OAuth consent in a flow exactly as the consent page does").

## The problem

A `kortix_oat_` token from the authorization-code flow (`apps/api/src/oauth/index.ts`: a third-party client, an MCP client, a Kortix Backend that signs in with Kortix) acts as the person who consented. `applyOAuthAccessTokenPrincipal` (`apps/api/src/middleware/auth-oauth.ts`) sets no MFA level and no `iamTokenId`, so `mfaGateBlocks` (`apps/api/src/iam/authorize.ts`) refuses it in every account with `mfa_required`. Every project and account action answers `403 account_mfa_required` for every member who is not a super admin. Identity probes (`/v1/accounts/me`, `/v1/oauth/userinfo`) still work.

The App viewer token had the same bug. It is fixed by recording the level at mint time: `access-session` marks the App cookie `aal: 'aal2'` only for a browser session at aal2, the gate copies it into `oauth_access_tokens.mfa_aal`, and `requestMfaAal` (`apps/api/src/middleware/actor.ts`) honors it in the token's own account only. Third-party tokens never set the column: consent (`/v1/oauth/authorize`, `/v1/oauth/consent`) does not record the session's level today.

## The design to build

1. At consent, read the consenting session's `aal` (`c.get('mfaAal')`). Store it on the authorization code.
2. Carry it to `oauth_access_tokens.mfa_aal` (exists) and a new `oauth_refresh_tokens.mfa_aal`. A refresh keeps it.
3. `validateOAuthAccessToken` already returns it and `buildActor` already honors it in the token's `account_id`. Decide whether a bound token should use its bound workspace's account instead. An unbound token (issued before 2026-11-06) keeps no level.
4. When the consenting account requires MFA and the session is aal1, the consent page asks for the second factor first (the web step-up already keys on `code: 'account_mfa_required'`).
5. Tests: a REST flow in an MFA account (local Supabase has MFA off: consent before the requirement is switched on, as `APP-6` does), plus a unit test that the level never crosses accounts.

## Open questions

- Should a token minted at aal1, in an account that turns MFA on later, stop working at once? Today an App sign-in (8 h, renewed) keeps working, and so would this.
- Migration: three tables, nullable column, no backfill (old tokens stay without a level).

## How to pick it up

Read the ledger entry "Record a delegated token's MFA level when it is minted" (`entries/2026-11-11T133430Z-record-a-delegated-token-s-mfa-level-when-it-is-minted-from.md`), then `apps/api/src/oauth/index.ts` (consent and `issueTokenPair`) and the migration skill.
