/**
 * A job's folder in the project's Files: `/Evals/<job_name>/`, in the layout of
 * Harbor's `jobs/` directory.
 *
 *   config.json                    the resolved job config
 *   result.json                    the job's stats, written when it ends
 *   <trial_name>/config.json       task, agent, model, attempt
 *   <trial_name>/result.json       rewards, exception, timings, session id
 *   <trial_name>/verifier/…        reward.json|txt, test-stdout.txt, what test.sh left in /logs/verifier
 *   <trial_name>/agent/…           the oracle's solve output
 *
 * Every file is written once, by the API, through the volume file API: no
 * sandbox mounts this folder, so there is one writer per file.
 */
import { ensureProjectDrive, getDrive, readDriveVolume, writeDriveVolume, type DriveRow } from '../../drives/service';
import { listVolumeFiles, readVolumeFile, removeVolumeFile, writeVolumeFiles } from '../../drives/volumes';

export const EVALS_FOLDER = '/Evals';
export const jobFolder = (jobName: string): string => `${EVALS_FOLDER}/${jobName}`;
export const trialFolder = (folder: string, trialName: string): string => `${folder}/${trialName}`;

export interface StoredFile {
  /** Path below the folder the call names. */
  path: string;
  content: string | Uint8Array<ArrayBuffer>;
}

const bytes = (content: StoredFile['content']): Uint8Array<ArrayBuffer> =>
  typeof content === 'string' ? (new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>) : content;

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function evalsDrive(accountId: string, projectId: string): Promise<DriveRow> {
  return ensureProjectDrive(accountId, projectId);
}

/** Write files below `folder` as one commit. */
export async function writeEvalFiles(drive: DriveRow, folder: string, files: StoredFile[]): Promise<void> {
  if (files.length === 0) return;
  await writeDriveVolume(drive, (volume) =>
    writeVolumeFiles(volume, files.map((file) => ({ path: `${folder}/${file.path}`, bytes: bytes(file.content) })), { overwrite: true }),
  );
}

export async function listEvalFiles(driveId: string | null, folder: string): Promise<Array<{ path: string; size: number }>> {
  const drive = driveId ? await getDrive(driveId) : null;
  if (!drive) return [];
  const entries = await readDriveVolume(drive, (volume) => listVolumeFiles(volume, folder, true), () => []);
  return entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ path: entry.path.startsWith(`${folder}/`) ? entry.path.slice(folder.length + 1) : entry.path, size: entry.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** One file of a job folder, or null when it does not exist. */
export async function readEvalFile(driveId: string | null, path: string): Promise<Response | null> {
  const drive = driveId ? await getDrive(driveId) : null;
  if (!drive) return null;
  try {
    return await readDriveVolume(drive, (volume) => readVolumeFile(volume, path), () => null);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function removeEvalFolder(driveId: string | null, folder: string): Promise<void> {
  const drive = driveId ? await getDrive(driveId) : null;
  if (!drive || !folder.startsWith(`${EVALS_FOLDER}/`)) return;
  await readDriveVolume(drive, (volume) => removeVolumeFile(volume, folder, true), () => undefined).catch(() => undefined);
}
