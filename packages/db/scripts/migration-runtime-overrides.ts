import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from './sha256';

const AUDIT_V2_MIGRATION = '20260807221200000_centralized_audit_v2.sql';
const AUDIT_V2_SHA256 = '769b863ef0b62c4693e232cf102757ce3c3ee904f0f44c9aea450901a56e07f9';
const AUDIT_V2_TIMEOUT = "SET statement_timeout = '120s';";
const AUDIT_V2_RUNTIME_TIMEOUT = "SET statement_timeout = '30min';";
const REMOVE_LOCAL_DOCKER_MIGRATION = '20260807165721291_remove_local_docker_provider.sql';
const REMOVE_LOCAL_DOCKER_SHA256 = 'e0cfc4b8df7598ee3dfb485606d264fa5b915fd03871873019bd0d005b9b120b';
const REMOVE_LOCAL_DOCKER_INSERTION_POINT = `DROP TRIGGER IF EXISTS trg_session_sandbox_identity_immutable
  ON kortix.session_sandboxes;--> statement-breakpoint

`;
const REMOVE_LOCAL_DOCKER_RUNTIME_DROP = `-- Runtime correction: historical databases can retain this compatibility
-- view. It depends on project_sessions.sandbox_provider and blocks the enum
-- rewrite in this immutable migration.
DROP VIEW IF EXISTS kortix.workspace_sessions;--> statement-breakpoint

`;

const RBAC_CUTOVER_VIEWS_MIGRATION = '20260819160100000_rbac_cutover_views.sql';
const RBAC_CUTOVER_VIEWS_SHA256 = '81fd7a986fe0039c12656c4f3b70a356651d6492da457c6ca07f17b64f0c3f87';
const RBAC_CUTOVER_VIEWS_INSERTION_POINT = `ALTER TABLE kortix.role_permissions
  VALIDATE CONSTRAINT role_permissions_action_permissions_fk;`;
const RBAC_CUTOVER_VIEWS_RUNTIME_CLEANUP = `-- Runtime correction: long-lived databases (dev was the first) hold
-- role_permissions rows whose action string was RETIRED from the catalog —
-- the pre-#6554 spellings project.cr.open / project.cr.merge (folded into the
-- gitops leaves) and the dead trigger.* family. The local DB this migration
-- was proved on had zero such rows, so the VALIDATE below 23503'd on dev and
-- blocked every deploy. Map the renamed pair onto the surviving leaves
-- (dedup-aware), then drop anything else the catalog no longer names. Bounded
-- DML: role_permissions is a per-custom-role action list (hundreds of rows),
-- not a data table.
UPDATE kortix.role_permissions rp
   SET action = m.new_action
  FROM (VALUES ('project.cr.open',  'project.gitops.push'),
               ('project.cr.merge', 'project.gitops.merge')) AS m(old_action, new_action)
 WHERE rp.action = m.old_action
   AND NOT EXISTS (
     SELECT 1 FROM kortix.role_permissions d
      WHERE d.role_id = rp.role_id AND d.action = m.new_action
   );

DELETE FROM kortix.role_permissions rp
 WHERE NOT EXISTS (
   SELECT 1 FROM kortix.permissions p WHERE p.action = rp.action
 );

ALTER TABLE kortix.role_permissions
  VALIDATE CONSTRAINT role_permissions_action_permissions_fk;`;

// Two intermediate covering indexes of the gateway_logs index chain INCLUDE
// the `metadata` jsonb column. Prod rows carry metadata up to ~25 KB, past the
// 2,704-byte btree tuple limit, so both builds fail there (deploy-prod
// 42732045038: "index row size 4944 exceeds btree version 4 maximum 2704").
// Both indexes are dropped later in the same chain (20261107164458570 and
// 20261108090000500), and v4 (20261108090000300) replaces them without
// metadata. On a database that has not run them, the build is skipped.
const SUPERSEDED_GATEWAY_INDEX_MIGRATIONS = [
  {
    file: '20261107145000000_gateway_logs_project_time_covering_v2.concurrent.ts',
    sha256: '15ea45fea1f2f8bb6a5ae57e168a7bf6ff3b63ea155f8470e68b1cfc1e4142fc',
    index: 'idx_gateway_logs_project_time_covering_v2',
  },
  {
    file: '20261107164457464_gateway_logs_project_time_covering_v3.concurrent.ts',
    sha256: 'cf95e4114020843b8d65fc93d49d21c1b6be262af1591e88798584cf33105a52',
    index: 'idx_gateway_logs_project_time_covering_v3',
  },
] as const;

/** The one `pgm.sql(...)` block that builds `index`, and the no-op that replaces it. */
function supersededIndexBuild(source: string, index: string): string | null {
  const start = source.indexOf(`  pgm.sql(\`\n    create index concurrently if not exists ${index}\n`);
  if (start < 0 || source.indexOf(`create index concurrently if not exists ${index}`, start + 1) !== source.lastIndexOf(`create index concurrently if not exists ${index}`)) return null;
  const end = source.indexOf('\n  `);\n', start);
  if (end < 0) return null;
  return source.slice(start, end + '\n  `);\n'.length);
}

const SUPERSEDED_INDEX_NO_OP =
  '  // Runtime correction: superseded by idx_gateway_logs_project_time_covering_v4,\n' +
  '  // and dropped later in this chain. Its INCLUDE (metadata) cannot be built\n' +
  '  // where a row\'s metadata exceeds the btree tuple limit.\n';

interface RuntimeOverrideOptions {
  /** Test seam. Production always uses the committed migration checksum above. */
  expectedSha256?: string;
  removeLocalDockerExpectedSha256?: string;
  rbacCutoverViewsExpectedSha256?: string;
  supersededIndexExpectedSha256?: Record<string, string>;
}

interface MigrationRuntimeDirectory {
  path: string;
  appliedOverrides: string[];
  cleanup: () => void;
}

/**
 * Materialize the immutable migration set used by node-pg-migrate.
 *
 * Migration files remain immutable after merge. A runtime correction must
 * match the exact committed checksum and alter only the approved statement.
 */
export function materializeMigrationRuntimeDirectory(
  sourceDirectory: string,
  options: RuntimeOverrideOptions = {},
): MigrationRuntimeDirectory {
  const auditPath = join(sourceDirectory, AUDIT_V2_MIGRATION);
  const removeLocalDockerPath = join(sourceDirectory, REMOVE_LOCAL_DOCKER_MIGRATION);
  const rbacCutoverViewsPath = join(sourceDirectory, RBAC_CUTOVER_VIEWS_MIGRATION);
  const hasAuditOverride = existsSync(auditPath);
  const hasRemoveLocalDockerOverride = existsSync(removeLocalDockerPath);
  const hasRbacCutoverViewsOverride = existsSync(rbacCutoverViewsPath);
  const supersededIndexSources = SUPERSEDED_GATEWAY_INDEX_MIGRATIONS.flatMap((migration) => {
    const path = join(sourceDirectory, migration.file);
    if (!existsSync(path)) return [];
    const source = readFileSync(path, 'utf8');
    const expectedSha256 = options.supersededIndexExpectedSha256?.[migration.file] ?? migration.sha256;
    const actualSha256 = sha256Hex(source);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`${migration.file} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
    }
    const block = supersededIndexBuild(source, migration.index);
    if (!block) throw new Error(`${migration.file} expected exactly one ${migration.index} build statement`);
    return [{ ...migration, source, block }];
  });
  if (
    !hasAuditOverride &&
    !hasRemoveLocalDockerOverride &&
    !hasRbacCutoverViewsOverride &&
    supersededIndexSources.length === 0
  ) {
    return { path: sourceDirectory, appliedOverrides: [], cleanup: () => {} };
  }

  const auditSource = hasAuditOverride ? readFileSync(auditPath, 'utf8') : null;
  const removeLocalDockerSource = hasRemoveLocalDockerOverride
    ? readFileSync(removeLocalDockerPath, 'utf8')
    : null;
  const rbacCutoverViewsSource = hasRbacCutoverViewsOverride
    ? readFileSync(rbacCutoverViewsPath, 'utf8')
    : null;
  if (auditSource) {
    const expectedSha256 = options.expectedSha256 ?? AUDIT_V2_SHA256;
    const actualSha256 = sha256Hex(auditSource);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `${AUDIT_V2_MIGRATION} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    const occurrenceCount = auditSource.split(AUDIT_V2_TIMEOUT).length - 1;
    if (occurrenceCount !== 1) {
      throw new Error(
        `${AUDIT_V2_MIGRATION} expected exactly one ${JSON.stringify(AUDIT_V2_TIMEOUT)} statement; found ${occurrenceCount}`,
      );
    }
  }
  if (removeLocalDockerSource) {
    const expectedSha256 = options.removeLocalDockerExpectedSha256 ?? REMOVE_LOCAL_DOCKER_SHA256;
    const actualSha256 = sha256Hex(removeLocalDockerSource);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `${REMOVE_LOCAL_DOCKER_MIGRATION} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    const occurrenceCount = removeLocalDockerSource.split(REMOVE_LOCAL_DOCKER_INSERTION_POINT).length - 1;
    if (occurrenceCount !== 1) {
      throw new Error(
        `${REMOVE_LOCAL_DOCKER_MIGRATION} expected exactly one trigger insertion point; found ${occurrenceCount}`,
      );
    }
  }

  if (rbacCutoverViewsSource) {
    const expectedSha256 = options.rbacCutoverViewsExpectedSha256 ?? RBAC_CUTOVER_VIEWS_SHA256;
    const actualSha256 = sha256Hex(rbacCutoverViewsSource);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `${RBAC_CUTOVER_VIEWS_MIGRATION} checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    const occurrenceCount =
      rbacCutoverViewsSource.split(RBAC_CUTOVER_VIEWS_INSERTION_POINT).length - 1;
    if (occurrenceCount !== 1) {
      throw new Error(
        `${RBAC_CUTOVER_VIEWS_MIGRATION} expected exactly one role_permissions VALIDATE statement; found ${occurrenceCount}`,
      );
    }
  }
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'kortix-migrations-'));
  const runtimeDirectory = join(runtimeRoot, 'migrations');
  const appliedOverrides: string[] = [];
  try {
    cpSync(sourceDirectory, runtimeDirectory, { recursive: true });
    if (auditSource) {
      writeFileSync(
        join(runtimeDirectory, AUDIT_V2_MIGRATION),
        auditSource.replace(AUDIT_V2_TIMEOUT, AUDIT_V2_RUNTIME_TIMEOUT),
      );
      appliedOverrides.push(
        `${AUDIT_V2_MIGRATION}: statement_timeout 120s -> 30min (${AUDIT_V2_SHA256})`,
      );
    }
    if (removeLocalDockerSource) {
      writeFileSync(
        join(runtimeDirectory, REMOVE_LOCAL_DOCKER_MIGRATION),
        removeLocalDockerSource.replace(
          REMOVE_LOCAL_DOCKER_INSERTION_POINT,
          REMOVE_LOCAL_DOCKER_INSERTION_POINT + REMOVE_LOCAL_DOCKER_RUNTIME_DROP,
        ),
      );
      appliedOverrides.push(
        `${REMOVE_LOCAL_DOCKER_MIGRATION}: drop historical workspace_sessions view (${REMOVE_LOCAL_DOCKER_SHA256})`,
      );
    }
    if (rbacCutoverViewsSource) {
      writeFileSync(
        join(runtimeDirectory, RBAC_CUTOVER_VIEWS_MIGRATION),
        rbacCutoverViewsSource.replace(
          RBAC_CUTOVER_VIEWS_INSERTION_POINT,
          RBAC_CUTOVER_VIEWS_RUNTIME_CLEANUP,
        ),
      );
      appliedOverrides.push(
        `${RBAC_CUTOVER_VIEWS_MIGRATION}: retire project.cr.*/trigger.* role_permissions rows before the catalog-FK VALIDATE (${RBAC_CUTOVER_VIEWS_SHA256})`,
      );
    }
    for (const migration of supersededIndexSources) {
      writeFileSync(
        join(runtimeDirectory, migration.file),
        migration.source.replace(migration.block, SUPERSEDED_INDEX_NO_OP),
      );
      appliedOverrides.push(
        `${migration.file}: skip the superseded ${migration.index} build (${migration.sha256})`,
      );
    }
  } catch (error) {
    rmSync(runtimeRoot, { force: true, recursive: true });
    throw error;
  }

  let cleaned = false;
  return {
    path: runtimeDirectory,
    appliedOverrides,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(runtimeRoot, { force: true, recursive: true });
    },
  };
}
