import { createHash } from 'node:crypto';

/** The one sha256 in packages/db: hex digest of a string or byte buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
