/**
 * Operator backfill: move every legacy LLM provider credential
 * (`kortix.project_secrets`, consumer `llm_gateway`) into the named store
 * (`kortix.account_secret_resources`), the one the Models panel lists.
 *
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/llm-credential-backfill.ts                       # dry run
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/llm-credential-backfill.ts --apply               # move
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/llm-credential-backfill.ts --project <uuid> ...  # one project
 *   ... --verbose     one line per legacy row: id, name, outcome (never a value)
 *
 * Needs the API's own `API_KEY_SECRET` (the named store's seal) and the
 * project-secret key of that environment: run it with the environment's API
 * env file, never another's.
 *
 * What it does, per row (`apps/api/src/secrets/llm-credential-move.ts`):
 *   - copied            a new named account holds the value; readers use it.
 *   - already_present   a named account with the same value existed; readers use it.
 *   - unchanged         moved by an earlier run and not written since.
 *   - recopied          moved earlier, written since: the named account took the new value.
 *   - skipped_*         stays legacy and is still read (audience, owner, unread name).
 *   - failed_*          stays legacy; the value cannot be decrypted.
 * It records every outcome in `kortix.llm_credential_backfill` and deletes
 * nothing: the legacy rows stay until a later change removes them.
 *
 * Idempotent: run it again at any time. A re-run touches only rows written
 * since the last run.
 */
import { backfillLegacyLlmCredentials } from '../src/secrets/llm-credential-move';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verbose = args.includes('--verbose');
const projectIndex = args.indexOf('--project');
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
for (const [i, a] of args.entries()) {
  if (a === '--apply' || a === '--verbose' || a === '--project' || (i === projectIndex + 1 && projectIndex >= 0)) continue;
  throw new Error(`unknown arg ${a}`);
}
if (projectIndex >= 0 && !/^[0-9a-f-]{36}$/i.test(projectId ?? '')) throw new Error('--project needs a project uuid');

const started = Date.now();
const summary = await backfillLegacyLlmCredentials({
  apply,
  ...(projectId ? { projectId } : {}),
  onResult: verbose
    ? (r) => process.stdout.write(`${r.legacySecretId}\t${r.name}\t${r.outcome}${r.detail ? `\t${r.detail}` : ''}\n`)
    : undefined,
});
process.stdout.write(`\n${apply ? 'APPLIED' : 'DRY RUN (no writes; pass --apply)'}: ${summary.scanned} legacy llm_gateway rows in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
for (const [outcome, count] of Object.entries(summary.outcomes).sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${outcome.padEnd(22)} ${count}\n`);
}
process.exit(0);
