'use client';

import type { FileNode } from '../../../internal/files/types';
import { binaryBlobKeys, useRuntimeStore } from '@kortix/sdk/react';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { clearMissingFileReadsUnder } from '../../../internal/files/file-read-retry';
import {
  copyFile,
  createFile,
  deleteFile,
  mkdirFile,
  renameFile,
  toDaemonPath,
  uploadFile,
  type UploadResult,
} from '../../../internal/files/runtime-files';
import { fileContentKeys } from './use-file-content';
import { fileListKeys } from './use-file-list';
import { gitStatusKeys } from './use-git-status';

// ---------------------------------------------------------------------------
// Written paths
// ---------------------------------------------------------------------------

/**
 * A write brought `paths` into existence: forget the missing-file marks at and
 * under them, then re-read the open viewers and previews of those paths.
 *
 * Without this, a path read before its write (the New file row's card reads
 * the path before the create chain runs) kept its 404: the missing-file gate
 * answered every refetch with "File not found" for 5 minutes (D-08). The
 * marks clear first, so the invalidation below reaches the daemon. Only the
 * written paths re-read: a 500-file upload must not re-read every open file
 * 500 times.
 */
function settleWrittenPaths(
  queryClient: QueryClient,
  serverUrl: string | null | undefined,
  paths: readonly string[],
  options: { refetchContent?: boolean } = {},
) {
  for (const path of paths) clearMissingFileReadsUnder(serverUrl, path);
  if (options.refetchContent === false || paths.length === 0) return;
  const written = paths.map(toDaemonPath);
  const touches = (queryKey: readonly unknown[]) => {
    const keyPath = queryKey[3];
    if (typeof keyPath !== 'string') return false;
    // Same runtime server only: the path on another box is another file.
    if (typeof serverUrl === 'string' && typeof queryKey[2] === 'string' && queryKey[2] !== serverUrl) return false;
    const path = toDaemonPath(keyPath);
    return written.some((w) => w === '' || path === w || path.startsWith(`${w}/`));
  };
  for (const root of [fileContentKeys.all, binaryBlobKeys.all]) {
    const filters = { queryKey: root, predicate: (query: { queryKey: readonly unknown[] }) => touches(query.queryKey) };
    // A read in flight began before the write: its 404 is stale. Cancel it
    // first, or invalidation would reuse that request and still show "File
    // not found" (a query with no data dedups onto its pending fetch).
    void queryClient
      .cancelQueries(filters)
      .catch(() => undefined)
      .then(() => queryClient.invalidateQueries(filters));
  }
}

const joinUploadPath = (targetPath: string | undefined, name: string) =>
  targetPath ? `${targetPath.replace(/\/+$/, '')}/${name}` : name;

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export function useFileUpload() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  return useMutation<UploadResult[], Error, { file: File | Blob; targetPath?: string }>({
    mutationFn: ({ file, targetPath }) => uploadFile(file, targetPath),
    onSuccess: (results, { file, targetPath }) => {
      // The requested path, plus the one the daemon reports (it suffixes a
      // name that is taken).
      const name = (file as Partial<File>).name;
      const written = (results ?? []).map((r) => r.path).filter(Boolean);
      if (name) written.push(joinUploadPath(targetPath, name));
      settleWrittenPaths(queryClient, serverUrl, written);
      queryClient.invalidateQueries({ queryKey: fileListKeys.all });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function useFileDelete() {
  const queryClient = useQueryClient();

  return useMutation<boolean, Error, { filePath: string }>({
    mutationFn: ({ filePath }) => deleteFile(filePath),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileListKeys.all });
      queryClient.invalidateQueries({ queryKey: fileContentKeys.all });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Mkdir
// ---------------------------------------------------------------------------

export function useFileMkdir() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  return useMutation<boolean, Error, { dirPath: string }>({
    mutationFn: ({ dirPath }) => mkdirFile(dirPath),
    onSuccess: (_ok, { dirPath }) => {
      // A new folder holds no file yet: clear the marks, read nothing now.
      settleWrittenPaths(queryClient, serverUrl, [dirPath], { refetchContent: false });
      queryClient.invalidateQueries({ queryKey: fileListKeys.all });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export function useFileRename() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  return useMutation<boolean, Error, { from: string; to: string }>({
    mutationFn: ({ from, to }) => renameFile(from, to),
    onMutate: async ({ from, to }) => {
      // Optimistically update the file list cache for the parent directory
      const parentPath = from.substring(0, from.lastIndexOf('/')) || '/workspace';
      const newName = to.split('/').pop() || '';
      const queryKey = fileListKeys.dir(serverUrl, parentPath);

      // Cancel any in-flight queries for this dir
      await queryClient.cancelQueries({ queryKey });

      // Snapshot previous data for rollback
      const previousData = queryClient.getQueryData<FileNode[]>(queryKey);

      // Optimistically update the cache
      if (previousData) {
        queryClient.setQueryData<FileNode[]>(queryKey, (old) =>
          old?.map((node) => {
            if (node.path !== from) return node;
            // Update the absolute path by replacing the old name with the new one
            const absoluteDir = node.absolute.substring(0, node.absolute.lastIndexOf('/'));
            return {
              ...node,
              name: newName,
              path: to,
              absolute: `${absoluteDir}/${newName}`,
            };
          }),
        );
      }

      return { previousData, queryKey };
    },
    onError: (_err: unknown, _vars: unknown, context: unknown) => {
      const ctx = context as { previousData?: unknown; queryKey?: unknown[] } | undefined;
      // Rollback on error
      if (ctx?.previousData && ctx?.queryKey) {
        queryClient.setQueryData(ctx.queryKey, ctx.previousData);
      }
    },
    onSuccess: (_ok, { to }) => {
      // The target, and everything a moved folder carried, now exists. Its
      // previews (images, PDFs) re-read; other open previews do not.
      settleWrittenPaths(queryClient, serverUrl, [to]);
    },
    onSettled: () => {
      // Always refetch to ensure consistency with server
      queryClient.invalidateQueries({ queryKey: fileListKeys.all });
      queryClient.invalidateQueries({ queryKey: fileContentKeys.all });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Create empty file
// ---------------------------------------------------------------------------

export function useFileCreate() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  return useMutation<UploadResult[], Error, { filePath: string }>({
    mutationFn: ({ filePath }) => createFile(filePath),
    onSuccess: (results, { filePath }) => {
      settleWrittenPaths(queryClient, serverUrl, [filePath, ...(results ?? []).map((r) => r.path).filter(Boolean)]);
      queryClient.invalidateQueries({ queryKey: fileListKeys.all });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Copy file
// ---------------------------------------------------------------------------

export function useFileCopy() {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  return useMutation<UploadResult[], Error, { sourcePath: string; destPath: string }>({
    mutationFn: ({ sourcePath, destPath }) => copyFile(sourcePath, destPath),
    onSuccess: (results, { destPath }) => {
      settleWrittenPaths(queryClient, serverUrl, [destPath, ...(results ?? []).map((r) => r.path).filter(Boolean)]);
      queryClient.invalidateQueries({ queryKey: fileListKeys.all });
      queryClient.invalidateQueries({ queryKey: gitStatusKeys.all });
    },
  });
}
