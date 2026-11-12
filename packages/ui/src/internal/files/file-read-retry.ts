import { ApiError, isRuntimeStartingError } from '@kortix/sdk';

export const UPLOADED_FILE_READ_RETRY_DELAY_MS = 2_000;
export const UPLOADED_FILE_READ_RETRY_WINDOW_MS = 60_000;
export const UPLOADED_FILE_READ_MAX_RETRIES = Math.ceil(
  UPLOADED_FILE_READ_RETRY_WINDOW_MS / UPLOADED_FILE_READ_RETRY_DELAY_MS,
);

export function isUploadedWorkspacePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/^\/+/, '');
  return (
    normalized === 'uploads' ||
    normalized.startsWith('uploads/') ||
    normalized === 'workspace/uploads' ||
    normalized.startsWith('workspace/uploads/')
  );
}

export function fileReadRetryDelayMs(attempt: number, filePath?: string | null): number {
  if (isUploadedWorkspacePath(filePath)) return UPLOADED_FILE_READ_RETRY_DELAY_MS;
  return Math.min(1000 * Math.pow(2, attempt), 5000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
}

function isPermanentFileReadFailure(error: unknown): boolean {
  // Prefer a numeric HTTP status when the thrown error carries one: any 4xx
  // except 408/429 is a client error that won't fix itself on retry.
  const status = (error as { status?: unknown } | null)?.status;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return true;
  }
  const msg = errorMessage(error);
  return (
    msg.includes('404') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('400') ||
    msg.includes('bad request') ||
    // A directory read (e.g. `.kortix`) returns 400 "Path is a directory" —
    // permanent, must not be retried on a loop.
    msg.includes('is a directory') ||
    msg.includes('eisdir') ||
    msg.includes('not found') ||
    msg.includes('access denied') ||
    msg.includes('forbidden') ||
    msg.includes('unauthorized') ||
    msg.includes('unprocessable') ||
    msg.includes('no such file') ||
    msg.includes('enoent') ||
    msg.includes('does not exist') ||
    msg.includes('path not found')
  );
}

function isMissingFileReadFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 404;
  const msg = errorMessage(error);
  return (
    msg.includes('404') ||
    msg.includes('not found') ||
    msg.includes('no such file') ||
    msg.includes('enoent') ||
    msg.includes('does not exist') ||
    msg.includes('path not found')
  );
}

// ── Missing-file gate ─────────────────────────────────────────────────────────
// A path a session page reads whose file is gone (404 forever) keeps failing,
// and the SDK's event stream invalidates every open file query on each
// `file.edited` and at turn end — so one dead preview card re-read the miss
// for as long as its session ran. While a miss is younger than this window
// the two React Query file hooks (`use-file-content`, `use-binary-blob`)
// answer their invalidation refetches without touching the file system; a
// read that finds the file clears the mark, and after the window a refetch
// reads normally again.
export const MISSING_FILE_SUPPRESS_MS = 5 * 60_000;

let missingFileNow: () => number = () => Date.now();

/** Set by tests so a check never waits on the real clock; production never calls it. */
export function setMissingFileClockForTests(now: () => number): void {
  missingFileNow = now;
}

// ponytail: a stale entry evicts lazily on its next read; no sweeper until a
// memory profile of a long-lived tab asks for one.
const missingFiles = new Map<string, number>();

/** Clears the registry between tests; production never calls it. */
export function clearMissingFileReadsForTests(): void {
  missingFiles.clear();
}

const missingFileKey = (serverUrl: string | null | undefined, filePath: string) =>
  `${serverUrl ?? ''}|${filePath}`;

/** Remember the miss when the read failed as missing; other failures pass through. */
export function noteMissingFileRead(
  serverUrl: string | null | undefined,
  filePath: string | null | undefined,
  error: unknown,
): void {
  if (!filePath || !isMissingFileReadFailure(error)) return;
  missingFiles.set(missingFileKey(serverUrl, filePath), missingFileNow());
}

/** Forget the mark after a read found the file. */
export function clearMissingFileRead(serverUrl: string | null | undefined, filePath: string | null | undefined): void {
  if (!filePath) return;
  missingFiles.delete(missingFileKey(serverUrl, filePath));
}

/** True while the file's read miss is fresh enough that a refetch may not touch it. */
export function missingFileSuppressed(
  serverUrl: string | null | undefined,
  filePath: string | null | undefined,
): boolean {
  if (!filePath) return false;
  const at = missingFiles.get(missingFileKey(serverUrl, filePath));
  if (at === undefined) return false;
  if (missingFileNow() - at > MISSING_FILE_SUPPRESS_MS) {
    missingFiles.delete(missingFileKey(serverUrl, filePath));
    return false;
  }
  return true;
}

/** The fast-fail a suppressed refetch throws in the reader's place. */
export function missingFileReadError(): Error {
  return new ApiError('File or folder not found', { status: 404, code: 'not_found' });
}

// How often a file query re-polls while the sandbox reports a readiness 503
// ("sandbox not ready (status: …)"). The control plane answers these without
// dialling the box, so the poll is cheap; the query keeps polling until the
// box is active and the file loads on its own.
export const SANDBOX_WAKING_REFETCH_INTERVAL_MS = 3_000;

/**
 * Re-read cadence while the box is asleep. Slower, never off.
 *
 * A PARKED box resumes only on the next SEND, and the API refuses every read
 * meant to wake it — so the 3s boot cadence is ~20 requests a minute against a
 * state that cannot change on its own. But it still has to be WATCHED: the send
 * that wakes the box can come from the composer, another tab, or a trigger, and
 * when it does the file must appear without the user hunting for a retry
 * button. Stopping the poll outright would trade a busy wait for a dead one.
 *
 * 30s: the same reasoning as `POLL_PARKED` in the SDK's runtime reconnect.
 */
export const SANDBOX_PARKED_REFETCH_INTERVAL_MS = 30_000;

/**
 * How often to re-read a file that failed with a sandbox-readiness 503.
 *
 * The 3s comment above describes a BOOTING box, and for that box it is right:
 * the file appears on its own in seconds. A parked box takes the slow lane.
 */
export function sandboxWakingRefetchInterval(error: unknown, parked: boolean): number | false {
  // Also the runtime URL not pinned yet ("Server URL not ready"): it clears on its own too.
  if (!isRuntimeStartingError(error)) return false;
  return parked ? SANDBOX_PARKED_REFETCH_INTERVAL_MS : SANDBOX_WAKING_REFETCH_INTERVAL_MS;
}

/** The image wait's polls (R38): 1, 2, 4, 8 s, then every 10 s, about 2 min in all. */
export const IMAGE_WAKING_ATTEMPTS = 15;

/**
 * The poll interval of an image read while the session runtime is still
 * starting (`isRuntimeStartingError`), after its `failures`-th failed read:
 * 1 s doubling to a 10 s cap; `false` (stop) after `IMAGE_WAKING_ATTEMPTS`,
 * when the tile says the image is unavailable and offers Try again; `false`
 * for any other error. A file viewer keeps `sandboxWakingRefetchInterval`
 * (a parked box can take longer than an image tile should wait).
 */
export function imageWakingRefetchInterval(error: unknown, failures: number): number | false {
  if (!isRuntimeStartingError(error) || failures > IMAGE_WAKING_ATTEMPTS) return false;
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), 10_000);
}

/** True once an image read gave up waiting for the runtime (`imageWakingRefetchInterval`). */
export function imageWaitedOut(error: unknown, failures: number): boolean {
  return isRuntimeStartingError(error) && failures > IMAGE_WAKING_ATTEMPTS;
}

export function shouldRetryFileRead(
  filePath: string | null | undefined,
  failureCount: number,
  error: unknown,
): boolean {
  // A parked/booting sandbox is not a failed read. Fail fast out of the inline
  // retry loop so the viewer can render its "waking up" state immediately; the
  // query-level poll (SANDBOX_WAKING_REFETCH_INTERVAL_MS) re-reads until the
  // sandbox is back.
  if (isRuntimeStartingError(error)) return false;

  if (isUploadedWorkspacePath(filePath)) {
    if (isPermanentFileReadFailure(error) && !isMissingFileReadFailure(error)) return false;
    return failureCount < UPLOADED_FILE_READ_MAX_RETRIES;
  }

  if (isPermanentFileReadFailure(error)) return false;
  return failureCount < 3;
}
