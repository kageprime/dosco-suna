/**
 * Operator backfill: move the legacy credential rows that are not LLM keys to
 * their canonical form (`apps/api/src/secrets/legacy-credential-backfill.ts`).
 * LLM provider keys have their own script, `llm-credential-backfill.ts`.
 *
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/legacy-credential-backfill.ts                 # dry run
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/legacy-credential-backfill.ts --apply         # move
 *   ... --concept connector_secret_strategy|connector_secret_consumer|external_connection   one concept
 *   ... --project <uuid>                                           one project
 *   ... --verbose                                                  one line per row: concept, id, outcome
 *
 * Outcomes: `would_move` (dry run), `moved`, `skipped_changed` (the row
 * changed between the scan and its lock). Every move is recorded with the
 * columns it changed in `kortix.legacy_credential_backfill`. Idempotent: a
 * re-run finds nothing to move. It reads no secret value and deletes nothing.
 */
import { backfillLegacyCredentials, LEGACY_CREDENTIAL_CONCEPTS, type LegacyCredentialConcept } from '../src/secrets/legacy-credential-backfill';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const known = new Set(['--apply', '--verbose', '--project', '--concept']);
for (const [i, a] of args.entries()) {
  if (known.has(a) || (i > 0 && (args[i - 1] === '--project' || args[i - 1] === '--concept'))) continue;
  throw new Error(`unknown arg ${a}`);
}
const projectId = option('--project');
if (args.includes('--project') && !/^[0-9a-f-]{36}$/i.test(projectId ?? '')) throw new Error('--project needs a project uuid');
const concept = option('--concept');
if (args.includes('--concept') && !(LEGACY_CREDENTIAL_CONCEPTS as readonly string[]).includes(concept ?? '')) {
  throw new Error(`--concept is one of ${LEGACY_CREDENTIAL_CONCEPTS.join(', ')}`);
}
const apply = flag('--apply');

const started = Date.now();
const summary = await backfillLegacyCredentials({
  apply,
  ...(projectId ? { projectId } : {}),
  ...(concept ? { concepts: [concept as LegacyCredentialConcept] } : {}),
  onResult: flag('--verbose') ? (r) => process.stdout.write(`${r.concept}\t${r.objectId}\t${r.outcome}\n`) : undefined,
});
process.stdout.write(`\n${apply ? 'APPLIED' : 'DRY RUN (no writes; pass --apply)'} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
for (const [name, outcomes] of Object.entries(summary.outcomes)) {
  if (concept && name !== concept) continue;
  const parts = Object.entries(outcomes).map(([o, n]) => `${o} ${n}`);
  process.stdout.write(`  ${name.padEnd(28)} ${parts.length ? parts.join(', ') : 'nothing to move'}   (ledger: ${summary.ledger[name as LegacyCredentialConcept]} moved)\n`);
}
process.exit(0);
