/**
 * Managed-repo scaffold seed: verification and state recording.
 *
 * A brand-new managed project is only usable once its repo carries a real
 * commit on the default branch — the agents, skills, `kortix.yaml`, and the
 * rest of the runtime config live IN the repo, and every session
 * branch forks off `refs/heads/<default_branch>`. A repo with no default
 * branch is therefore structurally dead: the file browser is empty, no agent
 * resolves, manifest detection falls back to v1, and a git read of the base
 * fails with `fatal: couldn't find remote ref refs/heads/main`.
 *
 * `POST /projects/provision` used to report `201 { status: 'active' }` for
 * exactly that repo whenever the caller did not pass `seed_starter: true`, and
 * nothing anywhere recorded whether a seed had been expected. This module
 * closes both halves:
 *
 *  1. `pushVerifiedSeed` — a seed is not "done" because the backend call
 *     resolved. It is done when `refs/heads/<branch>` is observably present on
 *     the remote. Anything else is a loud, project-id-tagged failure, bounded
 *     by one retry.
 *  2. `buildManagedRepoSeedState` / `readManagedRepoSeedState` — the seed
 *     intent AND outcome live on `project.metadata.git.seed`, so "empty
 *     because the caller asked for an empty repo" is distinguishable from
 *     "empty because the seed never landed". The scaffold is guaranteed at
 *     provision time; no on-access repair exists.
 *
 * ## The invariant: a project ALWAYS has a manifest
 *
 * This module used to end with "the fix is never 'always seed'; it is 'always
 * know, and repair only what was supposed to be seeded'". That was half right
 * and it left a hole big enough to drive a product bug through.
 *
 * `seed_starter` answers **who supplies the manifest** — the server now, or a
 * client that is about to push its own `kortix init` scaffold. It does NOT
 * answer *whether the project gets one*. Both designed paths end with a
 * `kortix.yaml` (see provision-core.ts: `kortix ship` scaffolds via
 * `kortix init` — same `@kortix/starter`, same file). Reading the flag as
 * "should this project have files at all" is what allowed a caller who said
 * nothing — a bare `POST /v1/projects/provision`, an agent, any integration —
 * to get a repo with no manifest, no agents and no skills, recorded as
 * `caller_opted_out` — skipped forever, in exactly
 * the case where nobody owns the first commit.
 *
 * So: **seeding is the default, and `expected` is now always true.** An
 * explicit `seed_starter: false` still suppresses the provision-time push —
 * `kortix ship` pushes its own history with a plain (non-force) push, and
 * seeding first would turn that into a non-fast-forward rejection — but it
 * records `client_owns_first_commit`, not "leave this empty": `kortix ship`
 * supplies that manifest too.
 *
 * Net: the scaffold is guaranteed at provision time. The seeded push is
 * verified before the provision reports success, and a failed seed deletes the
 * upstream repo AND `db.delete(projects)` the row the provision just inserted
 * (the seed rollback inside `runProvision`, see `../lib/provision-idempotency.ts`
 * on the in-flight window) — a project row that survives carries the scaffold
 * on its default branch, from the server or from the client that owns the first
 * commit.
 */

import type { GitConnectionRef, GitHostBackend, SeedFile } from './git-backends/types';

/** Recorded on `project.metadata.git.seed`. */
export interface ManagedRepoSeedState {
  /** The default branch was verified present on the remote. */
  seeded: boolean;
  /** The provisioning caller asked for a scaffold seed. */
  expected: boolean;
  /** Why the repo is in this state — surfaced in logs and decisions. */
  reason: ManagedRepoSeedReason;
  /** ISO timestamp of the last transition. */
  at: string;
  /** Starter template the seed used, so a re-provision reproduces it faithfully. */
  template?: string;
}

export type ManagedRepoSeedReason =
  | 'seeded'
  | 'pending'
  /**
   * The caller sent `seed_starter: false` because it is about to push its own
   * `kortix init` scaffold (`kortix ship`). NOT "this project may be empty" —
   * the state still carries `expected: true`. Replaces `caller_opted_out`.
   */
  | 'client_owns_first_commit'
  /** @deprecated Pre-invariant rows only. Read, never written — see the header. */
  | 'caller_opted_out'
  | 'push_failed'
  | 'verify_failed'
  | 'self_healed';

export type ManagedRepoSeedStage = 'push' | 'verify';

/** A seed that did not verifiably produce the default branch. Never swallowed. */
export class ManagedRepoSeedError extends Error {
  readonly projectId: string;
  readonly stage: ManagedRepoSeedStage;
  readonly branch: string;

  constructor(input: {
    projectId: string;
    stage: ManagedRepoSeedStage;
    branch: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `managed repo seed ${input.stage} failed for project ${input.projectId} ` +
        `(default branch "${input.branch}"): ${input.detail}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'ManagedRepoSeedError';
    this.projectId = input.projectId;
    this.stage = input.stage;
    this.branch = input.branch;
  }
}

/**
 * Total pushes attempted by `pushVerifiedSeed`. A bounded retry covers the two
 * transient shapes we have actually seen — a 5xx from the hosting backend, and
 * a ref that has not appeared yet — without ever looping. Re-pushing is safe
 * because a retry only happens while the branch is still ABSENT, so there is no
 * tip to fast-forward from and no double commit to create.
 */
const MAX_SEED_ATTEMPTS = 2;

/**
 * Backoff between pushes while a freshly created repo is not yet reachable over
 * git. GitHub acknowledges `POST /repos` before the git transport (and the
 * installation token's repo scope) sees the repo, so the first pushes answer
 * `Repository not found` / `HTTP 404` / `Write access ... not granted`.
 * Total 39 s: long enough for the lag seen in prod (6 provision rollbacks of
 * ~254 in 7 days, all after 2 instant pushes), short of any client giving up;
 * `/provision` and `/provision-stream` are exempt from the request deadline.
 */
const REPO_REACHABLE_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000, 8000, 8000];

/** Is this push failure "the repo I just created is not visible to git yet"? */
export function isRepoNotYetReachableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    text.includes('Repository not found') ||
    text.includes('HTTP 404') ||
    text.includes('returned error: 404') ||
    text.includes('Write access to repository not granted')
  );
}

/**
 * Push the scaffold, then PROVE the default branch exists. Resolves only when
 * the remote observably carries `refs/heads/<branch>`.
 *
 * `push` and `remoteHasBranch` are injected so the transport (code.storage
 * commit-pack, a `git push` from a temp clone, `git ls-remote`) stays with its
 * owner and this control flow stays unit-testable.
 *
 * Fails CLOSED: if the verification check itself cannot answer, the seed is
 * reported as unverified. Reporting a project active on an unproven repo is the
 * exact defect this replaces.
 */
export async function pushVerifiedSeed(input: {
  projectId: string;
  branch: string;
  push: () => Promise<void>;
  remoteHasBranch: () => Promise<boolean>;
  maxAttempts?: number;
  /** Injected so tests do not wait out the backoff. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_SEED_ATTEMPTS);
  const sleep = input.sleep ?? Bun.sleep;
  let lastDetail = 'the default branch was still absent after the seed push';
  let lastStage: ManagedRepoSeedStage = 'verify';
  let lastCause: unknown;
  let attempts = 0; // pushes made (logged)
  let failures = 0; // failures that spend the generic `maxAttempts` budget
  let waits = 0; // backoff sleeps spent on "repo not reachable yet"

  while (failures < maxAttempts) {
    attempts += 1;
    try {
      await input.push();
    } catch (error) {
      lastStage = 'push';
      lastCause = error;
      lastDetail = error instanceof Error ? error.message : String(error);
      // A push that errored client-side may still have landed (observed:
      // `! [rejected] main -> main (fetch first)` on the retry). Never re-push
      // over a branch that is already there.
      if (await input.remoteHasBranch().catch(() => false)) return;
      if (isRepoNotYetReachableError(error)) {
        if (waits >= REPO_REACHABLE_BACKOFF_MS.length) break;
        await sleep(REPO_REACHABLE_BACKOFF_MS[waits++]);
      } else {
        failures += 1;
      }
      continue;
    }
    try {
      if (await input.remoteHasBranch()) return;
      lastStage = 'verify';
      lastCause = undefined;
      lastDetail = 'the default branch was still absent after the seed push';
    } catch (error) {
      lastStage = 'verify';
      lastCause = error;
      lastDetail = `could not verify the default branch: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    failures += 1;
  }

  const failure = new ManagedRepoSeedError({
    projectId: input.projectId,
    stage: lastStage,
    branch: input.branch,
    detail: lastDetail,
    cause: lastCause,
  });
  console.error(
    `[managed-repo-seed] project=${input.projectId} branch=${input.branch} ` +
      `stage=${lastStage} attempts=${attempts}: ${lastDetail}`,
  );
  throw failure;
}

export function buildManagedRepoSeedState(input: {
  seeded: boolean;
  expected: boolean;
  reason: ManagedRepoSeedReason;
  at: string;
  template?: string;
}): ManagedRepoSeedState {
  return {
    seeded: input.seeded,
    expected: input.expected,
    reason: input.reason,
    at: input.at,
    ...(input.template ? { template: input.template } : {}),
  };
}

/** Read `metadata.git.seed`. Null for a project provisioned before this existed. */
export function readManagedRepoSeedState(metadata: unknown): ManagedRepoSeedState | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const git = (metadata as { git?: unknown }).git;
  if (!git || typeof git !== 'object') return null;
  const seed = (git as { seed?: unknown }).seed;
  if (!seed || typeof seed !== 'object') return null;
  const raw = seed as Record<string, unknown>;
  if (typeof raw.seeded !== 'boolean' || typeof raw.expected !== 'boolean') return null;
  return {
    seeded: raw.seeded,
    expected: raw.expected,
    reason: (typeof raw.reason === 'string' ? raw.reason : 'pending') as ManagedRepoSeedReason,
    at: typeof raw.at === 'string' ? raw.at : '',
    ...(typeof raw.template === 'string' ? { template: raw.template } : {}),
  };
}

/**
 * Is this git failure "the default branch does not exist on the remote"?
 *
 * The two wordings a structurally empty managed repo produces, in order: a
 * shallow fetch of the default branch prints
 * `couldn't find remote ref refs/heads/<branch>`, and a `rev-parse --verify`
 * of the same ref prints `Needed a single revision`.
 *
 * Deliberately narrow. An auth failure, a timeout, or an unknown-pathspec error
 * must NOT be mistaken for a missing branch — that would turn a transient
 * outage into a repair push against a repo that already has history.
 */
export function isMissingRemoteBranchError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { message?: unknown; stderr?: unknown };
  const text = [
    typeof err.message === 'string' ? err.message : '',
    typeof err.stderr === 'string' ? err.stderr : '',
  ].join('\n');
  if (!text) return false;
  return text.includes("couldn't find remote ref") || text.includes('Needed a single revision');
}

/**
 * The one place that turns a set of seed files into commits on the remote,
 * used by provisioning. Prefers the backend's native
 * seam (code.storage's commit-pack) and falls back to a real `git push` from a
 * throwaway clone for any plain HTTPS remote.
 */
export async function pushSeedFiles(input: {
  backend: GitHostBackend;
  connRef: GitConnectionRef;
  token: string;
  branch: string;
  files: SeedFile[];
  baseFiles: SeedFile[];
}): Promise<void> {
  if (input.backend.seedFiles) {
    await input.backend.seedFiles(input.connRef, input.token, input.files, {
      branch: input.branch,
      message: 'chore: scaffold Kortix project',
      baseFiles: input.baseFiles,
    });
    return;
  }
  const { seedRepoViaGitPush } = await import('./git-backends/seed');
  await seedRepoViaGitPush({
    upstreamUrl: input.connRef.upstreamUrl,
    token: input.token,
    files: input.files,
    branch: input.branch,
    commitMessage: 'chore: scaffold Kortix project',
    baseFiles: input.baseFiles,
  });
}
