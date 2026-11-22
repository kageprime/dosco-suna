---
recorded: 2026-11-16T21:35:38Z
incident_date: 2026-11-16
---
# Never send a file-backed Blob as a fetch body in code the compiled kortix CLI runs: send bytes

**Rule:** In code the compiled `kortix` CLI runs (`apps/cli`, and the `@kortix/sdk` paths it calls), never pass a file-backed Blob (`Bun.file`, `openAsBlob`, or a slice of one) as a `fetch` body. Read it to bytes (`new Uint8Array(await blob.arrayBuffer())`) or send blocks of bytes.

**Trigger surface:** Writing an upload in the CLI or in an SDK function the CLI calls; touching `uploadDriveFile` in `packages/sdk/src/core/rest/projects-client/drives.ts`.

**Incident:** 2026-11-16, found by the My Kortix capability benchmark (#12777). Bun 1.3.14 `bun build --compile` binaries segfault (exit 132, "Illegal instruction") after a `fetch` whose body is a file-backed Blob. The same code under plain `bun` works. `kortix drive put` passed one for every file up to 64 MiB: the file uploaded, then the CLI crashed. Every agent saving to Drive with the CLI (My Kortix's prompt mandates it) read a failure for a file that landed. On prod until the next Promote. Fixed in #12777. The block path had already learned the same thing for slices.

**Enforcement:** `drives.test.ts` ("a single upload sends the Blob as bytes") fails when `uploadDriveFile` sends a Blob again. The My Kortix benchmark's Drive tasks (`drive-csv`, `document-brief`, `media-header-image`, `browser-js-page`) error with exit 132 when any CLI upload regresses. No lint for other call sites yet: a check for `body: <Blob>` in `apps/cli` would be the next enforcer.
