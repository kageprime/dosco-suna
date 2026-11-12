import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';

const reads = new Map<number, Promise<string>>();

/** Reads a bundled Expo asset's text once per app run; a failed read drops its entry, so the next call retries. */
export function loadBundledText(moduleId: number): Promise<string> {
  let pending = reads.get(moduleId);
  if (!pending) {
    pending = (async () => {
      const asset = await Asset.fromModule(moduleId).downloadAsync();
      return new File(asset.localUri ?? asset.uri).text();
    })().catch((error: unknown) => {
      reads.delete(moduleId);
      throw error;
    });
    reads.set(moduleId, pending);
  }
  return pending;
}
