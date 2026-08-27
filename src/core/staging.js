import { readIndex, writeIndex } from "./config.js";

export function stagedEntries(root) {
  return readIndex(root).staged || [];
}

function changeToEntry(change) {
  const entry = {
    action: change.suggestedAction,
    path: change.path,
    localPath: change.localMeta?.localPath || change.path,
  };

  if (change.fileId) {
    entry.fileId = change.fileId;
  }

  if (change.sourcePath) {
    entry.sourcePath = change.sourcePath;
  }

  if (change.remoteMeta?.path) {
    entry.remotePath = change.remoteMeta.path;
  }

  if (change.remoteMeta?.mimeType) {
    entry.remoteMimeType = change.remoteMeta.mimeType;
  }

  if (change.remoteMeta?.md5Checksum) {
    entry.remoteMd5Checksum = change.remoteMeta.md5Checksum;
  }

  if (change.localMeta?.md5) {
    entry.localMd5 = change.localMeta.md5;
  }

  if (Number.isFinite(change.localMeta?.size)) {
    entry.localSize = change.localMeta.size;
  }

  if (change.localMeta?.modifiedTime) {
    entry.localModifiedTime = change.localMeta.modifiedTime;
  }

  // Propagate folder flag so sync knows to create folder instead of uploading file
  if (change.localMeta?.isFolder || change.remoteMeta?.isFolder || change.snapshotMeta?.isFolder) {
    entry.isFolder = true;
  }

  if (change.suggestedAction === "delete_local" && change.snapshotMeta?.isFolder) {
    entry.recursiveLocalDelete = true;
  }

  return entry;
}

export function stageChange(root, change) {
  const index = readIndex(root);
  const staged = (index.staged || []).filter(
    (entry) => entry.path !== change.path
  );
  staged.push(changeToEntry(change));
  index.staged = staged;
  writeIndex(root, index);
}

export function stageChanges(root, changes) {
  const index = readIndex(root);
  const byPath = new Map((index.staged || []).map((entry) => [entry.path, entry]));

  for (const change of changes) {
    byPath.set(change.path, changeToEntry(change));
  }

  index.staged = [...byPath.values()];
  writeIndex(root, index);
  return changes.length;
}

export function stageRemoteFilesForDownload(root, remoteFiles) {
  const index = readIndex(root);
  const byPath = new Map((index.staged || []).map((entry) => [entry.path, entry]));

  for (const remoteFile of remoteFiles) {
    byPath.set(remoteFile.path, {
      action: "download",
      path: remoteFile.path,
      localPath: remoteFile.path,
      fileId: remoteFile.id,
      remotePath: remoteFile.path,
      ...(remoteFile.mimeType ? { remoteMimeType: remoteFile.mimeType } : {}),
      ...(remoteFile.md5Checksum ? { remoteMd5Checksum: remoteFile.md5Checksum } : {}),
      ...(remoteFile.isFolder ? { isFolder: true } : {}),
    });
  }

  index.staged = [...byPath.values()];
  writeIndex(root, index);
  return remoteFiles.length;
}

/**
 * Stage a full remote hydration without losing deletions known from the
 * snapshot diff. `pull --all` re-downloads every current remote item, but it
 * must also preserve remote-deleted and renamed paths so committing the
 * hydration cannot silently rebase them away.
 */
export function stageFullRemotePull(
  root,
  remoteFiles,
  remoteDeletions = [],
  remoteRenames = []
) {
  const index = readIndex(root);
  const byPath = new Map((index.staged || []).map((entry) => [entry.path, entry]));

  for (const remoteFile of remoteFiles) {
    byPath.set(remoteFile.path, {
      action: "download",
      path: remoteFile.path,
      localPath: remoteFile.path,
      fileId: remoteFile.id,
      remotePath: remoteFile.path,
      ...(remoteFile.mimeType ? { remoteMimeType: remoteFile.mimeType } : {}),
      ...(remoteFile.md5Checksum ? { remoteMd5Checksum: remoteFile.md5Checksum } : {}),
      ...(remoteFile.isFolder ? { isFolder: true } : {}),
    });
  }

  for (const change of remoteDeletions) {
    byPath.set(change.path, changeToEntry(change));
  }

  // A renamed folder shares its destination with a full-download folder
  // entry. Keep the move so the existing local tree is relocated before any
  // descendant downloads run, rather than leaving the old directory stale.
  for (const change of remoteRenames) {
    byPath.set(change.path, changeToEntry(change));
  }

  index.staged = [...byPath.values()];
  writeIndex(root, index);
  return remoteFiles.length + remoteDeletions.length + remoteRenames.length;
}

export function unstagePath(root, targetPath) {
  const index = readIndex(root);
  const staged = index.staged || [];
  const next = staged.filter((entry) => entry.path !== targetPath);

  if (next.length === staged.length) {
    return false;
  }

  index.staged = next;
  writeIndex(root, index);
  return true;
}

export function unstageAll(root) {
  const index = readIndex(root);
  const count = (index.staged || []).length;
  index.staged = [];
  writeIndex(root, index);
  return count;
}

export function conflictResolutionChange(change, strategy) {
  if (strategy === "theirs") {
    return {
      ...change,
      fileId: change.fileId || change.remoteMeta?.id,
      remotePath: change.remoteMeta?.path || change.path,
      remoteMimeType: change.remoteMeta?.mimeType,
      remoteMd5Checksum: change.remoteMeta?.md5Checksum,
      changeType: "remote_modified",
      suggestedAction: "download",
      shortStatus: "MR",
      description: "modified on Drive",
    };
  }

  if (strategy === "ours") {
    if (!change.localMeta) {
      return {
        ...change,
        changeType: "local_deleted",
        suggestedAction: "delete_remote",
        shortStatus: "-L",
        description: "deleted locally",
      };
    }

    return {
      ...change,
      changeType: "local_modified",
      suggestedAction: "upload",
      shortStatus: "ML",
      description: "modified locally",
    };
  }

  throw new Error(`Unsupported single-change conflict strategy: ${strategy}`);
}

/**
 * Stage a conflict with an explicit resolution strategy.
 * @param {"ours"|"theirs"|"both"} strategy
 */
export function stageConflictResolution(root, change, strategy) {
  if (strategy === "theirs") {
    return stageChange(root, conflictResolutionChange(change, strategy));
  }

  if (strategy === "ours") {
    return stageChange(root, conflictResolutionChange(change, strategy));
  }

  if (strategy === "both") {
    // Keep both: download remote as .remote copy, keep local as-is, then upload local
    const index = readIndex(root);
    const staged = (index.staged || []).filter(
      (entry) => entry.path !== change.path
    );

    // Stage download of remote with a renamed path
    const ext = change.path.includes(".") ? "." + change.path.split(".").pop() : "";
    const base = ext ? change.path.slice(0, -ext.length) : change.path;
    const remoteCopyPath = `${base}.remote${ext}`;

    staged.push({
      action: "download",
      path: remoteCopyPath,
      localPath: remoteCopyPath,
      fileId: change.fileId || change.remoteMeta?.id,
      remotePath: change.remoteMeta?.path || change.path,
      remoteMimeType: change.remoteMeta?.mimeType,
      remoteMd5Checksum: change.remoteMeta?.md5Checksum,
    });

    // Stage upload of local version
    staged.push({
      action: "upload",
      path: change.path,
      localPath: change.localMeta?.localPath || change.path,
      fileId: change.fileId || change.remoteMeta?.id,
      remotePath: change.remoteMeta?.path || change.path,
      ...(change.localMeta?.md5 ? { localMd5: change.localMeta.md5 } : {}),
      ...(Number.isFinite(change.localMeta?.size) ? { localSize: change.localMeta.size } : {}),
      ...(change.localMeta?.modifiedTime ? { localModifiedTime: change.localMeta.modifiedTime } : {}),
    });

    index.staged = staged;
    writeIndex(root, index);
  }
}
