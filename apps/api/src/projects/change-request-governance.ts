// What merging a change request lands on its base branch, classified before
// the merge runs:
//   - the manifest permissions the change needs. A change to `agents`,
//     `default_agent`, `triggers`, `connectors`, `policies` or `policy` needs
//     the permission its direct route asserts (`requiredManifestActions`), so
//     a merge cannot do what the merger could not do directly;
//   - the secrets its commits add (`secret-scan.ts`).
// Both read one head commit, and the merge lands that commit and no later one.

import type { AgentGrant } from '@kortix/db';
import { grantsOfManifestText } from './agents/grants';
import { requiredManifestActions } from './change-request-policy';
import { validateRef } from './git-ref';
import { blobIdsOfChanges, DIFF_BLOB_FETCH_MAX_BYTES, parseRawDiff, type RawChange } from './git/commits';
import { readManifestFromRepo } from './git/files';
import { wouldBeMergeCommit } from './git/merge';
import { ensureCommitTrees, ensureStoreObjects, GitOperationError, refreshMirror, runGit, runGitBuffer } from './git/mirror';
import { isObjectFetchTooLargeError } from './git/object-store';
import type { GitBackedProject } from './git/types';
import { MAX_SECRET_FINDINGS, scanAddedLines, type SecretScan } from './secret-scan';

/** The largest patch the secret scan reads. Above it the change is not scanned. */
const SECRET_SCAN_MAX_PATCH_BYTES = 32 * 1024 * 1024;
/** The most commits the secret scan reads. A longer branch is not scanned. */
const SECRET_SCAN_MAX_COMMITS = 500;
/**
 * The most merge commits it reads. Each costs a merge base and up to three
 * local diff listings, so this bounds the git processes one merge request spends.
 */
const SECRET_SCAN_MAX_MERGES = 20;
/**
 * The wall time the secret scan may spend. The merge route answers inside the
 * API's 25 s request deadline (middleware/request-deadline.ts), and the
 * refreshes, the manifest reads and the merge itself need the rest. Past it
 * the change comes back `unscanned`, never as a timeout.
 */
let SECRET_SCAN_BUDGET_MS = 10_000;

/** Tests set a small budget instead of waiting out the real one. */
export function setSecretScanBudgetMsForTests(ms: number): () => void {
  const previous = SECRET_SCAN_BUDGET_MS;
  SECRET_SCAN_BUDGET_MS = ms;
  return () => {
    SECRET_SCAN_BUDGET_MS = previous;
  };
}

export interface MergeClassification {
  /** The head commit every check read. The merge lands exactly this commit. */
  headSha: string;
  /** The base commit the manifest check compared against. The merge goes onto exactly this commit. */
  baseSha: string;
  /** The commit whose manifest the merge makes authoritative: the would-be merge, or the head when it conflicts. */
  manifestRef: string;
  /** Manifest permissions the change needs; `[]` when it changes none of the governed sections. */
  required: string[];
  /** Every agent's grant before and after, for the non-escalation check (iam/agent-grant-ceiling.ts). */
  grantsBefore: Map<string, AgentGrant>;
  grantsAfter: Map<string, AgentGrant>;
  /** What the change's commits add that looks like a secret; `unscanned` when it could not read them all. */
  secrets: SecretScan;
}

/**
 * Classify what merging `cr` does.
 *
 * Both refs are proved current first: the head branch is usually pushed
 * seconds before the merge, often through another API replica, and each
 * replica's mirror serves refs up to KORTIX_GIT_REFRESH_INTERVAL_MS stale.
 * Reading a stale mirror made the head ref unresolvable (release gate GH-17,
 * v0.13.31).
 *
 * Throws when a side cannot be read. The caller refuses the merge with a
 * retryable 503 (`CR_GOVERNANCE_UNVERIFIED`): it never merges a change it
 * could not classify. A change over the secret scan's bounds comes back with
 * `secrets.unscanned` set, and the caller refuses it unless a person overrides.
 */
export async function classifyMerge(
  project: GitBackedProject,
  cr: { baseRef: string; headRef: string },
): Promise<MergeClassification> {
  validateRef(cr.baseRef);
  validateRef(cr.headRef);
  const { manifestCandidatePaths } = await import('@kortix/manifest-schema');
  const candidates = manifestCandidatePaths(project.manifestPath);
  // One ls-remote per ref when it has not moved; a fetch when it has or when
  // this mirror has never seen it.
  await refreshMirror(project, true, { freshRef: cr.headRef });
  const repoPath = await refreshMirror(project, true, { freshRef: cr.baseRef });
  const resolve = async (ref: string) =>
    (await runGit(['rev-parse', '--verify', `refs/heads/${ref}^{commit}`], repoPath, false)).stdout.trim();
  const [headSha, baseSha] = [await resolve(cr.headRef), await resolve(cr.baseRef)];
  // Compare the base tip with what the merge would land, not the change
  // request's own diff: a merge can also undo what the base changed since the
  // branch point. A merge that conflicts does not land; its own diff stands in.
  const landed = await wouldBeMergeCommit(project, repoPath, baseSha, headSha);
  const mergeBase = landed
    ? baseSha
    : await runGit(['merge-base', baseSha, headSha], repoPath, false)
        .then((r) => r.stdout.trim() || null)
        .catch(() => null);
  const manifestRef = landed ?? headSha;
  const [before, after, secrets] = await Promise.all([
    readManifestFromRepo(project, candidates, mergeBase ?? baseSha, { strictRef: true }),
    readManifestFromRepo(project, candidates, manifestRef, { strictRef: true }),
    scanSecrets(repoPath, { baseRef: cr.baseRef, baseSha, headSha, landed }),
  ]);
  const baseText = before?.content ?? null;
  const headText = after?.content ?? null;
  return {
    headSha,
    baseSha,
    manifestRef,
    required: requiredManifestActions(baseText, headText),
    grantsBefore: grantsOfManifestText(baseText),
    grantsAfter: grantsOfManifestText(headText),
    secrets,
  };
}

/**
 * What looks like a secret in what the merge lands, read two ways:
 *
 *  - commit by commit, every commit new to `baseRef` (`base..head`): the merge
 *    carries each of them onto the base branch, so a key added in one commit
 *    and deleted in the next still lands in its history. A merge commit is read
 *    by what its resolution adds over an automatic merge of its parents
 *    (`remerge`);
 *  - the merge itself (`git diff base landed`): a key the base deleted that a
 *    conflict resolution on the branch kept comes back.
 *
 * A file git would call binary or `-diff` is read as text; a rename is
 * detected, so a file that only moves adds nothing. The store fetches what the
 * scan reads in two requests, the trees, then every file version. What the
 * scan cannot read — more than `SECRET_SCAN_MAX_COMMITS` commits or
 * `SECRET_SCAN_MAX_MERGES` merges, more file content than one fetch takes, a
 * patch over `SECRET_SCAN_MAX_PATCH_BYTES`, an octopus merge, more than
 * `SECRET_SCAN_BUDGET_MS` of wall time — comes back as `unscanned`, never as clean.
 */
async function scanSecrets(
  repoPath: string,
  input: { baseRef: string; baseSha: string; headSha: string; landed: string | null },
): Promise<SecretScan> {
  const deadline = Date.now() + SECRET_SCAN_BUDGET_MS;
  const unscanned = (reason: string): SecretScan => ({ findings: [], total: 0, unscanned: reason });
  const overBudget = () => unscanned(`it took longer than ${SECRET_SCAN_BUDGET_MS / 1000} s`);
  const left = () => deadline - Date.now();
  const range = `refs/heads/${input.baseRef}..${input.headSha}`;

  const listed = await runGit(['rev-list', '--parents', `--max-count=${SECRET_SCAN_MAX_COMMITS + 1}`, range], repoPath, false);
  const commits = listed.stdout.split('\n').filter(Boolean).map((line) => line.split(' '));
  if (commits.length > SECRET_SCAN_MAX_COMMITS) return unscanned(`more than ${SECRET_SCAN_MAX_COMMITS} commits`);
  if (commits.length === 0 && !input.landed) return { findings: [], total: 0 };
  if (commits.some((ids) => ids.length > 3)) return unscanned('an octopus merge');
  const merges = commits.filter((ids) => ids.length === 3) as Array<[string, string, string]>;
  if (merges.length > SECRET_SCAN_MAX_MERGES) return unscanned(`more than ${SECRET_SCAN_MAX_MERGES} merge commits`);

  // One git process at a time: the scan's cost stays proportional to its bounds.
  const mergeBases: Array<string | null> = [];
  for (const [, first, second] of merges) {
    mergeBases.push(
      await runGit(['merge-base', first, second], repoPath, false).then((r) => r.stdout.trim() || null).catch(() => null),
    );
  }
  // A partial store holds commits only (object-store.ts). Fetch every tree the
  // diffs read in one request, then list every file version they compare (local
  // reads) and fetch those in one more, bounded like the change-request diff.
  const landing = input.landed ? [[input.baseSha, input.landed]] : [];
  const pairs = [
    ...merges.flatMap(([merge, first, second], index) => {
      const base = mergeBases[index];
      return [[first, merge], ...(base ? [[base, first], [base, second]] : [])];
    }),
    ...landing,
  ];
  const trees = new Set([...commits.flat(), ...mergeBases.filter((id): id is string => id !== null), ...landing.flat()]);
  await ensureCommitTrees(repoPath, [...trees]);
  if (left() <= 0) return overBudget();
  const changes: RawChange[] = [];
  const listChanges = async (args: string[]) => {
    const raw = await runGit([...args, '--raw', '-z', '--no-renames', '--no-abbrev'], repoPath, false);
    changes.push(...parseRawDiff(raw.stdout));
  };
  if (commits.length > 0) await listChanges(['log', '--format=', '--no-merges', range]);
  for (const pair of pairs) await listChanges(['diff', ...pair]);
  try {
    await ensureStoreObjects(repoPath, blobIdsOfChanges(changes), { maxBytes: DIFF_BLOB_FETCH_MAX_BYTES, timeoutMs: left() });
  } catch (error) {
    if (isObjectFetchTooLargeError(error)) return unscanned('more file content than one scan reads');
    if (left() <= 0) return overBudget();
    throw error;
  }
  if (left() <= 0) return overBudget();

  const patchOf = async (args: string[]): Promise<SecretScan | null> => {
    try {
      const { stdout } = await runGitBuffer(
        ['-c', 'core.quotePath=false', ...args],
        repoPath,
        false,
        null,
        undefined,
        undefined,
        Math.max(left(), 1),
        undefined,
        SECRET_SCAN_MAX_PATCH_BYTES,
      );
      return scanAddedLines(stdout.toString('utf8'));
    } catch (error) {
      if (error instanceof GitOperationError && error.outputTooLarge) {
        return unscanned(`a patch over ${SECRET_SCAN_MAX_PATCH_BYTES / (1024 * 1024)} MB`);
      }
      if (error instanceof GitOperationError && error.kind === 'timeout') return overBudget();
      throw error;
    }
  };
  const flags = ['--text', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '-U0', '--src-prefix=a/', '--dst-prefix=b/'];
  const history = commits.length > 0
    ? await patchOf(['log', '-p', '--diff-merges=remerge', '--format=commit %H', ...flags, range])
    : { findings: [], total: 0 };
  if (!history || history.unscanned) return history ?? overBudget();
  if (!input.landed) return history;
  const merged = await patchOf(['diff', ...flags, input.baseSha, input.landed]);
  return merged ? combineScans(history, merged) : history;
}

/** Both scans; a landing finding a commit finding already names (same file and rule) is not counted twice. */
function combineScans(history: SecretScan, landing: SecretScan): SecretScan {
  const named = new Set(history.findings.map((f) => `${f.file}\0${f.rule}`));
  const extra = landing.findings.filter((f) => !named.has(`${f.file}\0${f.rule}`));
  const unscanned = history.unscanned ?? landing.unscanned;
  return {
    findings: [...history.findings, ...extra].slice(0, MAX_SECRET_FINDINGS),
    total: history.total + extra.length,
    ...(unscanned ? { unscanned } : {}),
  };
}
