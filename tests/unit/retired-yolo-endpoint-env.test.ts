import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as root } from '../src/fixtures/repo';

// The per-member YOLO usage endpoint is retired. Nothing in the codebase reads
// its URL: the sandbox no longer mints or injects a kyolo_ token
// (apps/api/src/platform/services/session-sandbox.ts), and the retired origin
// answers Cloudflare 530 / 1033 on every path, so re-provisioning its
// credential was pure dead weight. What the containers actually receive from
// these profiles is `dotenvx run`'s expansion of the dotenv v16 syntax dotenvx
// writes, so the guard checks that render output: every tracked .env profile
// parsed into its key set — not a text search over source, which would also
// fail on comments, docs and evidence reports. Re-adding the var to any
// profile is the failure this pins; the host itself now answers 410 Gone at
// the Cloudflare edge (a Worker route over the dead tunnel record:
// infra/cloudflare/workers/api-router). The prod deploy resolves the
// secrets_blob_arn blob that carries the live keys (environments/prod
// main.tf:87-88) and neutralizes the map-only Terraform fallback arm —
// terraform-only, since no HCL parser exists in this test tree, so that arm's
// row is reviewed in the diff rather than parsed here.
const retiredEnvVar = 'KORTIX_YOLO_URL';

/** .env.<profile> files the repo tracks, enumerated like env-encryption guard. */
function trackedEnvProfiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) =>
        /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/.test(file) &&
        // .env.example is a documentation template; .env.keys is the private
        // keyring (never deployed as a runtime profile).
        !/\.(keys|example)$/.test(file),
    );
}

describe('retired YOLO usage endpoint', () => {
  it('renders no KORTIX_YOLO_URL out of any tracked env profile', () => {
    const offenders = trackedEnvProfiles()
      .filter((file) => retiredEnvVar in parseEnv(readFileSync(join(root, file), 'utf8')))
      .map((file) => file);
    expect(offenders).toEqual([]);
  }, 20_000);
});
