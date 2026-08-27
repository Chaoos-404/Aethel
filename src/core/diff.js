import { isWorkspaceType } from "./drive-api.js";
import { loadIgnoreRules } from "./ignore.js";
import { loadPackManifest } from "./config.js";

export const ChangeType = Object.freeze({
  REMOTE_ADDED: "remote_added",
  REMOTE_MODIFIED: "remote_modified",
  REMOTE_DELETED: "remote_deleted",
  REMOTE_RENAMED: "remote_renamed",
  LOCAL_ADDED: "local_added",
  LOCAL_MODIFIED: "local_modified",
  LOCAL_DELETED: "local_deleted",
  LOCAL_RENAMED: "local_renamed",
  CONFLICT: "conflict",
  // Pack-specific change types
  PACK_LOCAL_MODIFIED: "pack_local_modified",
  PACK_REMOTE_MODIFIED: "pack_remote_modified",
  PACK_SYNCED: "pack_synced",
  PACK_CONFLICT: "pack_conflict",
  PACK_NEW: "pack_new",
});

const SHORT_STATUS = {
  [ChangeType.REMOTE_ADDED]: "+R",
  [ChangeType.REMOTE_MODIFIED]: "MR",
  [ChangeType.REMOTE_DELETED]: "-R",
  [ChangeType.REMOTE_RENAMED]: "RR",
  [ChangeType.LOCAL_ADDED]: "+L",
  [ChangeType.LOCAL_MODIFIED]: "ML",
  [ChangeType.LOCAL_DELETED]: "-L",
  [ChangeType.LOCAL_RENAMED]: "LR",
  [ChangeType.CONFLICT]: "!!",
  [ChangeType.PACK_LOCAL_MODIFIED]: "PL",
  [ChangeType.PACK_REMOTE_MODIFIED]: "PR",
  [ChangeType.PACK_SYNCED]: "P=",
  [ChangeType.PACK_CONFLICT]: "P!",
  [ChangeType.PACK_NEW]: "P+",
};

const DESCRIPTION = {
  [ChangeType.REMOTE_ADDED]: "new on Drive",
  [ChangeType.REMOTE_MODIFIED]: "modified on Drive",
  [ChangeType.REMOTE_DELETED]: "deleted on Drive",
  [ChangeType.REMOTE_RENAMED]: "renamed on Drive",
  [ChangeType.LOCAL_ADDED]: "new locally",
  [ChangeType.LOCAL_MODIFIED]: "modified locally",
  [ChangeType.LOCAL_DELETED]: "deleted locally",
  [ChangeType.LOCAL_RENAMED]: "renamed locally",
  [ChangeType.CONFLICT]: "both sides changed",
  [ChangeType.PACK_LOCAL_MODIFIED]: "pack changed locally",
  [ChangeType.PACK_REMOTE_MODIFIED]: "pack changed on Drive",
  [ChangeType.PACK_SYNCED]: "pack up to date",
  [ChangeType.PACK_CONFLICT]: "pack conflict",
  [ChangeType.PACK_NEW]: "new pack",
};

const SUGGESTED_ACTION = {
  [ChangeType.REMOTE_ADDED]: "download",
  [ChangeType.REMOTE_MODIFIED]: "download",
  [ChangeType.REMOTE_DELETED]: "delete_local",
  [ChangeType.REMOTE_RENAMED]: "move_local",
  [ChangeType.LOCAL_ADDED]: "upload",
  [ChangeType.LOCAL_MODIFIED]: "upload",
  [ChangeType.LOCAL_DELETED]: "delete_remote",
  [ChangeType.LOCAL_RENAMED]: "rename_remote",
  [ChangeType.CONFLICT]: "conflict",
  [ChangeType.PACK_LOCAL_MODIFIED]: "push_pack",
  [ChangeType.PACK_REMOTE_MODIFIED]: "pull_pack",
  [ChangeType.PACK_SYNCED]: "none",
  [ChangeType.PACK_CONFLICT]: "resolve_pack",
  [ChangeType.PACK_NEW]: "push_pack",
};

function createChange({
  changeType,
  path,
  fileId = null,
  remoteMeta = null,
  localMeta = null,
  snapshotMeta = null,
  sourcePath = null,
}) {
  return {
    changeType,
    path,
    fileId,
    remoteMeta,
    localMeta,
    snapshotMeta,
    ...(sourcePath ? { sourcePath } : {}),
    shortStatus: SHORT_STATUS[changeType],
    description: DESCRIPTION[changeType],
    suggestedAction: SUGGESTED_ACTION[changeType],
  };
}

function topmostMissingPath(remotePath, pathExists) {
  if (!pathExists) {
    return remotePath;
  }

  const parts = String(remotePath || "").split("/").filter(Boolean);
  const prefixes = [];

  for (const part of parts) {
    prefixes.push(part);
    const candidate = prefixes.join("/");
    if (!pathExists(candidate)) {
      return candidate;
    }
  }

  return remotePath;
}

export function changesWithLocalAuthority(changes, { pathExists } = {}) {
  const converted = changes.map((change) => {
    if (change.changeType !== ChangeType.REMOTE_ADDED) {
      return change;
    }

    const deletePath = topmostMissingPath(change.path, pathExists);
    const collapsed = deletePath !== change.path;

    return createChange({
      changeType: ChangeType.LOCAL_DELETED,
      path: deletePath,
      fileId: collapsed ? null : change.fileId,
      remoteMeta: collapsed ? null : change.remoteMeta,
      localMeta: change.localMeta,
      snapshotMeta: change.snapshotMeta,
    });
  });

  return [...new Map(
    converted.map((change) => [`${change.suggestedAction}:${change.path}`, change])
  ).values()];
}

function buildDiffResult(changes, packChanges = []) {
  return {
    changes,
    packChanges,
    get remoteChanges() {
      return this.changes.filter((change) =>
        change.changeType.startsWith("remote")
      );
    },
    get localChanges() {
      return this.changes.filter((change) =>
        change.changeType.startsWith("local")
      );
    },
    get conflicts() {
      return this.changes.filter(
        (change) => change.changeType === ChangeType.CONFLICT
      );
    },
    get packConflicts() {
      return this.packChanges.filter(
        (change) => change.changeType === ChangeType.PACK_CONFLICT
      );
    },
    get pendingPackChanges() {
      return this.packChanges.filter(
        (change) =>
          change.changeType === ChangeType.PACK_LOCAL_MODIFIED ||
          change.changeType === ChangeType.PACK_REMOTE_MODIFIED ||
          change.changeType === ChangeType.PACK_NEW
      );
    },
    get syncedPacks() {
      return this.packChanges.filter(
        (change) => change.changeType === ChangeType.PACK_SYNCED
      );
    },
    get hasPackChanges() {
      return this.pendingPackChanges.length > 0 || this.packConflicts.length > 0;
    },
    get isClean() {
      return this.changes.length === 0 && this.pendingPackChanges.length === 0;
    },
  };
}

function remoteChanged(snapshotEntry, remoteEntry) {
  // Folders don't change — only their existence matters
  if (remoteEntry.isFolder || remoteEntry.mimeType === "application/vnd.google-apps.folder") {
    return false;
  }

  if (isWorkspaceType(remoteEntry.mimeType || "")) {
    return snapshotEntry.modifiedTime !== remoteEntry.modifiedTime;
  }

  return snapshotEntry.md5Checksum !== remoteEntry.md5Checksum;
}

function localChanged(snapshotEntry, localEntry) {
  // Folders don't change — only their existence matters
  if (localEntry.isFolder) return false;
  return snapshotEntry.md5 !== localEntry.md5;
}

function promoteConflicts(changes) {
  const remoteByPath = new Map();
  const localByPath = new Map();

  for (const change of changes) {
    if (change.changeType.startsWith("remote")) {
      remoteByPath.set(change.path, change);
      continue;
    }

    if (change.changeType.startsWith("local")) {
      localByPath.set(change.path, change);
    }
  }

  const conflictPathSet = new Set();
  for (const pathValue of remoteByPath.keys()) {
    if (localByPath.has(pathValue)) {
      conflictPathSet.add(pathValue);
    }
  }

  if (conflictPathSet.size === 0) {
    return changes;
  }

  const filtered = changes.filter(
    (change) => !conflictPathSet.has(change.path)
  );

  for (const pathValue of [...conflictPathSet].sort()) {
    const remoteChange = remoteByPath.get(pathValue);
    const localChange = localByPath.get(pathValue);

    filtered.push(
      createChange({
        changeType: ChangeType.CONFLICT,
        path: pathValue,
        fileId: remoteChange.fileId,
        remoteMeta: remoteChange.remoteMeta,
        localMeta: localChange.localMeta,
        snapshotMeta: remoteChange.snapshotMeta || localChange.snapshotMeta,
      })
    );
  }

  return filtered;
}

/**
 * A file that was moved by a folder rename on one side and content-modified
 * on both sides produces a REMOTE_MODIFIED and a LOCAL_MODIFIED under two
 * different paths. Path-based promotion cannot pair them, and staging both
 * would race a download against an upload of the same Drive file. Pair them
 * by file ID instead and surface a single conflict at the local path.
 */
function promoteCrossPathModifyConflicts(changes) {
  const remoteModifiedByFileId = new Map();
  for (const change of changes) {
    if (change.changeType === ChangeType.REMOTE_MODIFIED && change.fileId) {
      remoteModifiedByFileId.set(change.fileId, change);
    }
  }
  if (remoteModifiedByFileId.size === 0) {
    return changes;
  }

  const consumedRemoteChanges = new Set();
  const conflicts = [];
  const kept = [];

  for (const change of changes) {
    if (change.changeType === ChangeType.LOCAL_MODIFIED && change.fileId) {
      const remoteChange = remoteModifiedByFileId.get(change.fileId);
      if (remoteChange && remoteChange.path !== change.path) {
        consumedRemoteChanges.add(remoteChange);
        conflicts.push(
          createChange({
            changeType: ChangeType.CONFLICT,
            path: change.path,
            fileId: change.fileId,
            remoteMeta: remoteChange.remoteMeta,
            localMeta: change.localMeta,
            snapshotMeta: remoteChange.snapshotMeta || change.snapshotMeta,
          })
        );
        continue;
      }
    }
    kept.push(change);
  }

  if (conflicts.length === 0) {
    return changes;
  }

  return [
    ...kept.filter((change) => !consumedRemoteChanges.has(change)),
    ...conflicts,
  ];
}

function promoteRenameDeleteConflicts(
  changes,
  snapshotFiles,
  remoteFiles,
  localFilesData
) {
  const remoteById = new Map(remoteFiles.map((file) => [file.id, file]));
  const conflictChanges = [];
  const handledPaths = new Set();

  // Index non-folder local files by content hash so each snapshot entry can
  // find its matches without rescanning every local file.
  const localPathsByMd5 = new Map();
  for (const [pathValue, localMeta] of Object.entries(localFilesData)) {
    if (localMeta.isFolder || !localMeta.md5) continue;
    const bucket = localPathsByMd5.get(localMeta.md5);
    if (bucket) bucket.push(pathValue);
    else localPathsByMd5.set(localMeta.md5, [pathValue]);
  }

  for (const [fileId, snapshotEntry] of Object.entries(snapshotFiles)) {
    if (snapshotEntry.isFolder || !snapshotEntry.md5Checksum) continue;

    const sourcePath = entryPath(snapshotEntry);
    if (!sourcePath) continue;

    const remoteEntry = remoteById.get(fileId);
    if (
      remoteEntry &&
      (remoteEntry.path === sourcePath || localFilesData[sourcePath])
    ) {
      continue;
    }

    const matchingLocalPaths = (
      localPathsByMd5.get(snapshotEntry.md5Checksum) || []
    ).filter((pathValue) => pathValue !== sourcePath);

    // Local rename and remote deletion are competing changes to the same
    // tracked file. Do not silently restore either side.
    if (!remoteEntry && matchingLocalPaths.length === 1) {
      const pathValue = matchingLocalPaths[0];
      handledPaths.add(sourcePath);
      handledPaths.add(pathValue);
      conflictChanges.push(
        createChange({
          changeType: ChangeType.CONFLICT,
          path: pathValue,
          sourcePath,
          localMeta: localFilesData[pathValue],
          snapshotMeta: snapshotEntry,
        })
      );
      continue;
    }

    // Remote rename and local deletion are likewise ambiguous. A matching
    // local file would indicate a local rename rather than deletion.
    if (
      remoteEntry &&
      remoteEntry.path !== sourcePath &&
      !localFilesData[sourcePath] &&
      matchingLocalPaths.length === 0
    ) {
      handledPaths.add(sourcePath);
      handledPaths.add(remoteEntry.path);
      conflictChanges.push(
        createChange({
          changeType: ChangeType.CONFLICT,
          path: remoteEntry.path,
          sourcePath,
          fileId,
          remoteMeta: remoteEntry,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  if (conflictChanges.length === 0) return changes;

  return [
    ...changes.filter((change) => !handledPaths.has(change.path)),
    ...conflictChanges,
  ];
}

/**
 * Compute pack-level changes by comparing local packedDirs against manifest.
 * @param {string|null} root - Workspace root for loading manifest
 * @param {object} packedDirs - Local packed directories from scanLocal
 * @param {object|null} snapshot - Previous snapshot (may contain packedDirs)
 * @returns {object[]} Array of pack change objects
 */
function computePackChanges(root, packedDirs, snapshot) {
  if (!root || !packedDirs || Object.keys(packedDirs).length === 0) {
    return [];
  }

  const manifest = loadPackManifest(root);
  const snapshotPackedDirs = snapshot?.packedDirs || {};
  const changes = [];

  for (const [packPath, packInfo] of Object.entries(packedDirs)) {
    const manifestEntry = manifest.packs?.[packPath];
    const snapshotEntry = snapshotPackedDirs[packPath];
    const localTreeHash = packInfo.treeHash;

    if (!manifestEntry) {
      // Pack not in manifest = new pack
      changes.push(
        createChange({
          changeType: ChangeType.PACK_NEW,
          path: packPath,
          localMeta: packInfo,
        })
      );
      continue;
    }

    const { localTreeHash: manifestLocalHash, remoteTreeHash: manifestRemoteHash } = manifestEntry;

    // Check for local modification
    const localChanged = localTreeHash !== manifestLocalHash;
    // Check for remote modification (comparing against what we last synced)
    const remoteChanged = manifestRemoteHash && manifestRemoteHash !== manifestLocalHash;

    if (localChanged && remoteChanged) {
      // Both sides changed = conflict
      changes.push(
        createChange({
          changeType: ChangeType.PACK_CONFLICT,
          path: packPath,
          localMeta: { ...packInfo, treeHash: localTreeHash },
          snapshotMeta: { treeHash: manifestLocalHash },
          remoteMeta: { treeHash: manifestRemoteHash },
        })
      );
    } else if (localChanged) {
      // Only local changed
      changes.push(
        createChange({
          changeType: ChangeType.PACK_LOCAL_MODIFIED,
          path: packPath,
          localMeta: { ...packInfo, treeHash: localTreeHash },
          snapshotMeta: { treeHash: manifestLocalHash },
        })
      );
    } else if (remoteChanged) {
      // Only remote changed
      changes.push(
        createChange({
          changeType: ChangeType.PACK_REMOTE_MODIFIED,
          path: packPath,
          localMeta: packInfo,
          remoteMeta: { treeHash: manifestRemoteHash },
          snapshotMeta: { treeHash: manifestLocalHash },
        })
      );
    } else {
      // No changes = synced
      changes.push(
        createChange({
          changeType: ChangeType.PACK_SYNCED,
          path: packPath,
          localMeta: packInfo,
        })
      );
    }
  }

  return changes;
}

/**
 * @param {object|null} snapshot
 * @param {object[]} remoteFiles
 * @param {object} localFiles
 * @param {{ root?: string, respectIgnore?: boolean }} options
 */
/**
 * Collect all implicit folder paths from a set of file paths.
 * e.g. "a/b/c.txt" → {"a", "a/b"}
 */
function collectFolderPaths(filePaths) {
  const folders = new Set();
  for (const p of filePaths) {
    // Walk ancestors right-to-left with substrings instead of split/slice/join:
    // once an ancestor is already recorded so are all of *its* ancestors, so
    // sibling files in the same directory cost a single lookup.
    let slashIndex = p.lastIndexOf("/");
    while (slashIndex > 0) {
      const folder = p.slice(0, slashIndex);
      if (folders.has(folder)) break;
      folders.add(folder);
      slashIndex = p.lastIndexOf("/", slashIndex - 1);
    }
  }
  return folders;
}

function indexSnapshotFilesByPath(snapshotFiles) {
  const byPath = new Map();

  for (const [fileId, entry] of Object.entries(snapshotFiles || {})) {
    for (const pathValue of [entry.path, entry.localPath]) {
      if (pathValue && !byPath.has(pathValue)) {
        byPath.set(pathValue, { fileId, entry });
      }
    }
  }

  return byPath;
}

function indexRemoteFilesByPath(remoteFiles) {
  const byPath = new Map();

  for (const remoteFile of remoteFiles) {
    if (remoteFile.path && !byPath.has(remoteFile.path)) {
      byPath.set(remoteFile.path, remoteFile);
    }
  }

  return byPath;
}

function entryPath(entry, fallback = "") {
  return entry?.path || entry?.localPath || fallback;
}

function filterSnapshotFilesByIgnore(snapshotFiles, ignoreRules) {
  if (!ignoreRules) {
    return snapshotFiles || {};
  }

  return Object.fromEntries(
    Object.entries(snapshotFiles || {}).filter(([, entry]) => {
      const pathValue = entryPath(entry);
      return !pathValue || !ignoreRules.ignores(pathValue);
    })
  );
}

function filterLocalFilesByIgnore(localFiles, ignoreRules) {
  if (!ignoreRules) {
    return localFiles || {};
  }

  return Object.fromEntries(
    Object.entries(localFiles || {}).filter(([relativePath, entry]) => {
      const pathValue = entryPath(entry, relativePath);
      return !pathValue || !ignoreRules.ignores(pathValue);
    })
  );
}

function remoteAndLocalEquivalent(remoteFile, localMeta) {
  const remoteIsFolder =
    remoteFile.isFolder ||
    remoteFile.mimeType === "application/vnd.google-apps.folder";
  const localIsFolder = Boolean(localMeta?.isFolder);

  if (remoteIsFolder || localIsFolder) {
    return remoteIsFolder === localIsFolder;
  }

  if (remoteFile.md5Checksum && localMeta?.md5) {
    return remoteFile.md5Checksum === localMeta.md5;
  }

  return false;
}

/**
 * Index a list of paths for O(1) ancestry checks:
 *   - `pathSet` — the paths themselves
 *   - `folderSet` — every implicit ancestor folder of those paths
 */
function indexPathsForAncestry(paths) {
  return { pathSet: new Set(paths), folderSet: collectFolderPaths(paths) };
}

function hasPathOrDescendant(pathIndex, parentPath) {
  return pathIndex.pathSet.has(parentPath) || pathIndex.folderSet.has(parentPath);
}

function isUnderAnyFolder(pathValue, folderPaths) {
  if (folderPaths.size === 0) return false;

  let slashIndex = pathValue.lastIndexOf("/");
  while (slashIndex > 0) {
    if (folderPaths.has(pathValue.slice(0, slashIndex))) return true;
    slashIndex = pathValue.lastIndexOf("/", slashIndex - 1);
  }
  return false;
}

function locallyDeletedAncestorPath(pathValue, snapshotLocalIndex, currentLocalIndex) {
  const parts = String(pathValue || "").split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (
      hasPathOrDescendant(snapshotLocalIndex, candidate) &&
      !hasPathOrDescendant(currentLocalIndex, candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function remotelyDeletedAncestorPath(pathValue, snapshotRemoteIndex, currentRemoteIndex, localFolderPaths) {
  const parts = String(pathValue || "").split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (
      localFolderPaths.has(candidate) &&
      hasPathOrDescendant(snapshotRemoteIndex, candidate) &&
      !hasPathOrDescendant(currentRemoteIndex, candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function folderSnapshotMeta(pathValue, snapshotRemoteByPath) {
  return {
    ...(snapshotRemoteByPath.get(pathValue)?.entry || {}),
    path: pathValue,
    localPath: pathValue,
    isFolder: true,
  };
}

function remapRenamedRemotePath(remotePath, renames) {
  if (renames.length === 0) return remotePath;
  for (const rename of [...renames].sort(
    (left, right) => right.to.split("/").length - left.to.split("/").length
  )) {
    if (remotePath === rename.to) return rename.from;
    if (remotePath.startsWith(`${rename.to}/`)) {
      return `${rename.from}${remotePath.slice(rename.to.length)}`;
    }
  }
  return remotePath;
}

function inferFolderRenamesFromDescendants(snapshotFiles, remoteById, remoteFolderPaths, localFolderPaths) {
  const candidates = new Map();

  for (const [fileId, snapshotEntry] of Object.entries(snapshotFiles)) {
    if (snapshotEntry.isFolder) continue;
    const remoteEntry = remoteById.get(fileId);
    const oldPath = entryPath(snapshotEntry);
    const newPath = remoteEntry?.path;
    if (!oldPath || !newPath || oldPath === newPath) continue;

    const oldParts = oldPath.split("/");
    const newParts = newPath.split("/");
    let shared = 0;
    while (shared < oldParts.length && shared < newParts.length && oldParts[shared] === newParts[shared]) {
      shared++;
    }
    if (shared >= oldParts.length || shared >= newParts.length) continue;

    const from = oldParts.slice(0, shared + 1).join("/");
    const to = newParts.slice(0, shared + 1).join("/");
    if (!remoteFolderPaths.has(to) || !localFolderPaths.has(from)) continue;
    const key = `${from}\0${to}`;
    candidates.set(key, { from, to, matches: (candidates.get(key)?.matches || 0) + 1 });
  }

  return [...candidates.values()]
    .sort((left, right) => right.matches - left.matches || left.from.localeCompare(right.from))
    .filter((candidate, index, all) =>
      !all.slice(0, index).some((chosen) =>
        candidate.from.startsWith(`${chosen.from}/`) || candidate.to.startsWith(`${chosen.to}/`)
      )
    );
}

function isRenamedDescendant(pathValue, renames) {
  return renames.some((rename) =>
    pathValue === rename.from || pathValue.startsWith(`${rename.from}/`)
  );
}

function remapRenamedLocalPath(localPath, renames) {
  if (renames.length === 0) return localPath;
  for (const rename of [...renames].sort(
    (left, right) => right.to.split("/").length - left.to.split("/").length
  )) {
    if (localPath === rename.to) return rename.from;
    if (localPath.startsWith(`${rename.to}/`)) {
      return `${rename.from}${localPath.slice(rename.to.length)}`;
    }
  }
  return localPath;
}

function applyLocalFolderRenames(snapshotPath, renames) {
  if (renames.length === 0) return snapshotPath;
  for (const rename of [...renames].sort(
    (left, right) => right.from.split("/").length - left.from.split("/").length
  )) {
    if (snapshotPath === rename.from) return rename.to;
    if (snapshotPath.startsWith(`${rename.from}/`)) {
      return `${rename.to}${snapshotPath.slice(rename.from.length)}`;
    }
  }
  return snapshotPath;
}

/**
 * Decide whether a snapshot folder missing locally was renamed locally
 * (remote descendants still at the old path) or renamed identically on both
 * sides (remote descendants already at the candidate path). Returns
 * "local_rename", "converged", or null when the evidence is mixed or absent.
 */
function classifyRenameAgainstRemoteDescendants(from, to, snapshotFiles, remoteById) {
  const fromPrefix = `${from}/`;
  let stillAtFrom = 0;
  let movedToTo = 0;

  for (const [fileId, entry] of Object.entries(snapshotFiles)) {
    const snapshotPath = entryPath(entry);
    if (!snapshotPath || !snapshotPath.startsWith(fromPrefix)) continue;

    const remoteEntry = remoteById.get(fileId);
    if (!remoteEntry) return null;

    if (remoteEntry.path === snapshotPath) {
      stillAtFrom++;
    } else if (remoteEntry.path === `${to}${snapshotPath.slice(from.length)}`) {
      movedToTo++;
    } else {
      return null;
    }
  }

  if (stillAtFrom > 0 && movedToTo === 0) return "local_rename";
  if (movedToTo > 0 && stillAtFrom === 0) return "converged";
  return null;
}

function sameDescendantFileHashes(descendants, candidate, localFileEntries) {
  const snapshotHashes = descendants
    .filter(([, meta]) => !meta.isFolder && meta.md5)
    .map(([, meta]) => meta.md5)
    .sort();
  const candidateHashes = localFileEntries
    .filter(
      ([pathValue, meta]) =>
        pathValue.startsWith(`${candidate}/`) && !meta.isFolder && meta.md5
    )
    .map(([, meta]) => meta.md5)
    .sort();

  return (
    snapshotHashes.length > 0 &&
    snapshotHashes.length === candidateHashes.length &&
    snapshotHashes.every((hash, index) => hash === candidateHashes[index])
  );
}

export function computeDiff(snapshot, remoteFiles, localFiles, { root, respectIgnore = true } = {}) {
  const ignoreRules = root && respectIgnore ? loadIgnoreRules(root) : null;

  // Pre-filter remote files by ignore rules
  if (ignoreRules) {
    remoteFiles = remoteFiles.filter((f) => !ignoreRules.ignores(f.path));
  }

  // Handle new localFiles format with .files and .packedDirs
  const localFilesData = filterLocalFilesByIgnore(localFiles?.files ?? localFiles, ignoreRules);
  const packedDirs = localFiles?.packedDirs ?? {};

  const changes = [];
  const snapshotFiles = filterSnapshotFilesByIgnore(snapshot?.files, ignoreRules);
  const snapshotLocalFiles = filterLocalFilesByIgnore(snapshot?.localFiles, ignoreRules);
  const snapshotRemoteByPath = indexSnapshotFilesByPath(snapshotFiles);
  const remoteByPath = indexRemoteFilesByPath(remoteFiles);
  const snapshotLocalIndex = indexPathsForAncestry(Object.keys(snapshotLocalFiles));
  const currentLocalIndex = indexPathsForAncestry(Object.keys(localFilesData));
  const snapshotRemoteIndex = indexPathsForAncestry(
    Object.values(snapshotFiles).map((entry) => entryPath(entry)).filter(Boolean)
  );
  const currentRemoteIndex = indexPathsForAncestry(
    remoteFiles.map((file) => file.path).filter(Boolean)
  );
  const locallyDeletedFolders = new Set();

  // Build sets of all folder paths that implicitly exist on each side
  // (from parent directories of files), so we can skip redundant folder additions.
  const remoteFolderPaths = new Set(currentRemoteIndex.folderSet);
  const localFolderPaths = new Set(currentLocalIndex.folderSet);

  // Also include explicit folder entries
  for (const f of remoteFiles) {
    if (f.isFolder) remoteFolderPaths.add(f.path);
  }
  for (const [p, meta] of Object.entries(localFilesData)) {
    if (meta.isFolder) localFolderPaths.add(p);
  }
  const remoteById = new Map(remoteFiles.map((file) => [file.id, file]));

  // A folder keeps its Drive ID when renamed.  Recognize the top-level folder
  // rename before comparing descendants by path, so its existing local tree is
  // moved intact instead of being deleted and downloaded one file at a time.
  const renamedFolders = [];
  for (const remoteFile of remoteFiles
    .filter((file) => file.isFolder && snapshotFiles[file.id])
    .sort((left, right) => (snapshotFiles[left.id].path || "").split("/").length - (snapshotFiles[right.id].path || "").split("/").length)) {
    const snapshotPath = entryPath(snapshotFiles[remoteFile.id]);
    if (!snapshotPath || snapshotPath === remoteFile.path) continue;
    if (remapRenamedRemotePath(remoteFile.path, renamedFolders) === snapshotPath) continue;
    // Do not mask a local deletion: a missing local source still needs the
    // normal download path to restore the renamed tree.
    if (!localFolderPaths.has(snapshotPath)) continue;
    renamedFolders.push({ from: snapshotPath, to: remoteFile.path, fileId: remoteFile.id });
  }
  const inferredRenamedFolders = inferFolderRenamesFromDescendants(
    snapshotFiles,
    remoteById,
    remoteFolderPaths,
    localFolderPaths
  );
  renamedFolders.push(...inferredRenamedFolders);

  // Local folder renames do not retain a filesystem ID in the snapshot, so
  // match an unmatched sibling folder by its unchanged tracked descendants.
  // This intentionally handles renames (same parent), not arbitrary moves.
  const locallyRenamedFolders = [];
  const convergedRenamedFolders = [];
  const snapshotLocalEntries = Object.entries(snapshotLocalFiles);
  const localFileEntries = Object.entries(localFilesData);
  const localFolderPathList = [...localFolderPaths];
  const snapshotFolderCandidates = [];
  const seenCandidatePaths = new Set();
  for (const [fileId, snapshotEntry] of Object.entries(snapshotFiles)) {
    if (!snapshotEntry.isFolder) continue;
    const from = entryPath(snapshotEntry);
    if (!from || seenCandidatePaths.has(from)) continue;
    seenCandidatePaths.add(from);
    snapshotFolderCandidates.push({ fileId, snapshotEntry, from });
  }
  // Non-empty folders carry no snapshot entry of their own (remote listings
  // only include empty folders), so also consider the folder paths implicit
  // in the snapshot's local baseline.
  for (const from of snapshotLocalIndex.folderSet) {
    if (seenCandidatePaths.has(from)) continue;
    seenCandidatePaths.add(from);
    snapshotFolderCandidates.push({ fileId: null, snapshotEntry: null, from });
  }
  snapshotFolderCandidates.sort(
    (left, right) => left.from.split("/").length - right.from.split("/").length
  );
  for (const { fileId, snapshotEntry, from } of snapshotFolderCandidates) {
    if (!from || localFolderPaths.has(from)) continue;
    const expectedCurrentPath = applyLocalFolderRenames(
      from,
      locallyRenamedFolders
    );
    const parent = expectedCurrentPath.includes("/")
      ? expectedCurrentPath.slice(0, expectedCurrentPath.lastIndexOf("/"))
      : "";
    if (localFolderPaths.has(expectedCurrentPath)) continue;
    // A rename destination is by definition a folder that did not exist at
    // snapshot time. Reject tracked folders before any content matching —
    // this keeps mass local deletions from scanning every sibling subtree.
    const cheapCandidates = localFolderPathList.filter((candidate) => {
      const candidateParent = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "";
      if (candidateParent !== parent || snapshotRemoteByPath.has(candidate)) return false;
      if (hasPathOrDescendant(snapshotLocalIndex, candidate)) return false;
      return !locallyRenamedFolders.some((rename) => candidate === rename.to);
    });
    if (cheapCandidates.length === 0) continue;
    const descendants = snapshotLocalEntries.filter(([candidate]) =>
      candidate.startsWith(`${from}/`)
    );
    const candidates = cheapCandidates.filter((candidate) => {
      // A folder renamed alongside edits to some of its files must still be
      // recognized: require every tracked descendant path to exist at the
      // mapped location, and at least half of the files to be unchanged.
      let allPathsPresent = true;
      let matchedFiles = 0;
      let totalFiles = 0;
      for (const [oldPath, oldMeta] of descendants) {
        const expectedOldPath = applyLocalFolderRenames(
          oldPath,
          locallyRenamedFolders
        );
        const mappedPath = `${candidate}${expectedOldPath.slice(expectedCurrentPath.length)}`;
        const current = localFilesData[mappedPath];
        if (!current) {
          allPathsPresent = false;
          break;
        }
        if (oldMeta.isFolder) continue;
        totalFiles += 1;
        if (oldMeta.md5 && oldMeta.md5 === current.md5) matchedFiles += 1;
      }
      const descendantMatch =
        allPathsPresent && (totalFiles === 0 || matchedFiles * 2 >= totalFiles);
      return (
        descendantMatch ||
        sameDescendantFileHashes(descendants, candidate, localFileEntries)
      );
    });
    if (candidates.length === 1) {
      const to = candidates[0];
      const remoteFolder = fileId ? remoteById.get(fileId) : null;
      let disposition = null;
      if (remoteFolder?.path === to) {
        disposition = "converged";
      } else if (remoteFolder?.path === from) {
        disposition = "local_rename";
      } else if (!remoteFolder) {
        // The folder itself is not in the remote listing (non-empty folders
        // are omitted); classify by where its tracked descendants live now.
        disposition = classifyRenameAgainstRemoteDescendants(
          from,
          to,
          snapshotFiles,
          remoteById
        );
      }
      if (disposition === "converged") {
        // Both sides made the same rename. There is no operation to perform,
        // but descendants still need their paths remapped for comparison.
        convergedRenamedFolders.push({ from, to, fileId, snapshotEntry });
      } else if (disposition === "local_rename") {
        locallyRenamedFolders.push({ from, to, fileId, snapshotEntry });
      }
    }
  }
  const remotePathRenames = [...renamedFolders, ...convergedRenamedFolders];
  const localPathRenames = [...locallyRenamedFolders, ...convergedRenamedFolders];

  // Constant-time lookups for the per-remote-file loop below.
  const inferredRenameTargets = new Set(
    inferredRenamedFolders.map((rename) => rename.to)
  );
  const convergedRenameFileIds = new Set(
    convergedRenamedFolders.map((rename) => rename.fileId)
  );
  const locallyRenamedByFileId = new Map(
    locallyRenamedFolders.map((rename) => [rename.fileId, rename])
  );
  const renamedByFileId = new Map(
    renamedFolders
      .filter((rename) => rename.fileId)
      .map((rename) => [rename.fileId, rename])
  );

  // Build remote lookup and detect additions/modifications in one pass
  const remoteBaselinePathsHandledLocally = new Set();
  for (const rename of inferredRenamedFolders) {
    changes.push(
      createChange({
        changeType: ChangeType.REMOTE_RENAMED,
        path: rename.to,
        sourcePath: rename.from,
        snapshotMeta: folderSnapshotMeta(rename.from, snapshotRemoteByPath),
      })
    );
  }
  // Emit local folder renames here rather than inside the remote loop: a
  // non-empty renamed folder has no remote listing entry to hang them on.
  for (const rename of locallyRenamedFolders) {
    changes.push(
      createChange({
        changeType: ChangeType.LOCAL_RENAMED,
        path: rename.to,
        sourcePath: rename.from,
        fileId: rename.fileId || null,
        localMeta: { path: rename.to, isFolder: true },
        snapshotMeta:
          rename.snapshotEntry || folderSnapshotMeta(rename.from, snapshotRemoteByPath),
      })
    );
  }
  for (const remoteFile of remoteFiles) {
    const snapshotEntry = snapshotFiles[remoteFile.id];

    if (inferredRenameTargets.has(remoteFile.path)) {
      continue;
    }

    if (convergedRenameFileIds.has(remoteFile.id)) {
      continue;
    }

    if (locallyRenamedByFileId.has(remoteFile.id)) {
      continue;
    }

    const renamedFolder = renamedByFileId.get(remoteFile.id);
    if (renamedFolder) {
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_RENAMED,
          path: renamedFolder.to,
          sourcePath: renamedFolder.from,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
          snapshotMeta: snapshotEntry,
        })
      );
      continue;
    }

    // A descendant has only moved because its ancestor was renamed. Its local
    // counterpart will move together with that ancestor.
    const remappedPath = remapRenamedRemotePath(remoteFile.path, remotePathRenames);
    if (
      snapshotEntry &&
      remappedPath !== remoteFile.path &&
      remappedPath === entryPath(snapshotEntry)
    ) {
      // The path change itself is covered by the folder move, but content
      // changes made at the same time still need to be applied afterwards.
      if (remoteChanged(snapshotEntry, remoteFile)) {
        changes.push(
          createChange({
            changeType: ChangeType.REMOTE_MODIFIED,
            path: remoteFile.path,
            fileId: remoteFile.id,
            remoteMeta: remoteFile,
            snapshotMeta: snapshotEntry,
          })
        );
      } else if (
        !remoteFile.isFolder &&
        !localFilesData[remappedPath] &&
        !localFilesData[remoteFile.path]
      ) {
        changes.push(
          createChange({
            changeType: ChangeType.REMOTE_ADDED,
            path: remoteFile.path,
            fileId: remoteFile.id,
            remoteMeta: remoteFile,
            snapshotMeta: snapshotEntry,
          })
        );
      }
      continue;
    }

    if (!snapshotEntry) {
      const remappedPath = remapRenamedRemotePath(remoteFile.path, remotePathRenames);
      if (remoteFile.isFolder && remappedPath !== remoteFile.path && localFolderPaths.has(remappedPath)) {
        continue;
      }
      const samePathSnapshot = snapshotRemoteByPath.get(remoteFile.path);

      if (samePathSnapshot) {
        changes.push(
          createChange({
            changeType: ChangeType.REMOTE_MODIFIED,
            path: remoteFile.path,
            fileId: remoteFile.id,
            remoteMeta: remoteFile,
            snapshotMeta: samePathSnapshot.entry,
          })
        );
        continue;
      }

      const localDeletePath = locallyDeletedAncestorPath(
        remoteFile.path,
        snapshotLocalIndex,
        currentLocalIndex
      );
      if (localDeletePath) {
        if (!locallyDeletedFolders.has(localDeletePath)) {
          const remoteFolder = remoteByPath.get(localDeletePath);
          locallyDeletedFolders.add(localDeletePath);
          changes.push(
            createChange({
              changeType: ChangeType.LOCAL_DELETED,
              path: localDeletePath,
              fileId: remoteFolder?.id || null,
              remoteMeta: remoteFolder || null,
              snapshotMeta: snapshotLocalFiles[localDeletePath] || null,
            })
          );
        }
        continue;
      }

      // Skip remote folder if it already exists locally (as parent or explicit dir)
      if (remoteFile.isFolder && localFolderPaths.has(remoteFile.path)) {
        continue;
      }
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_ADDED,
          path: remoteFile.path,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
        })
      );
      continue;
    }

    const snapshotPath = snapshotEntry.path || snapshotEntry.localPath || "";
    if (snapshotPath && snapshotPath !== remoteFile.path) {
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_DELETED,
          path: snapshotPath,
          fileId: remoteFile.id,
          snapshotMeta: snapshotEntry,
        })
      );

      if (!(remoteFile.isFolder && localFolderPaths.has(remoteFile.path))) {
        changes.push(
          createChange({
            changeType: ChangeType.REMOTE_ADDED,
            path: remoteFile.path,
            fileId: remoteFile.id,
            remoteMeta: remoteFile,
            snapshotMeta: snapshotEntry,
          })
        );
      }
      continue;
    }

    if (remoteChanged(snapshotEntry, remoteFile)) {
      // When an ancestor folder was renamed locally, the file's local copy
      // lives under the renamed path — download onto it instead of
      // recreating the old directory.
      const renameAdjustedLocalPath = applyLocalFolderRenames(
        remoteFile.path,
        localPathRenames
      );
      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_MODIFIED,
          path: remoteFile.path,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
          localMeta:
            renameAdjustedLocalPath !== remoteFile.path
              ? {
                  ...(localFilesData[renameAdjustedLocalPath] || {}),
                  localPath: renameAdjustedLocalPath,
                }
              : null,
          snapshotMeta: snapshotEntry,
        })
      );
      continue;
    }

    // Non-empty folders are not recorded in the local snapshot. When an
    // ancestor was renamed locally, their unchanged remote descendants now
    // live under the remapped local path and must not be mistaken for local
    // deletions.
    const remappedLocalFolderPath = applyLocalFolderRenames(
      remoteFile.path,
      localPathRenames
    );
    if (
      remoteFile.isFolder &&
      remappedLocalFolderPath !== remoteFile.path &&
      localFolderPaths.has(remappedLocalFolderPath)
    ) {
      continue;
    }

    const missingFromLocalBaseline = !Object.prototype.hasOwnProperty.call(
      snapshotLocalFiles,
      remoteFile.path
    );
    const missingLocally = !Object.prototype.hasOwnProperty.call(
      localFilesData,
      remoteFile.path
    );

    if (!missingFromLocalBaseline) {
      continue;
    }

    if (missingLocally) {
      if (
        remoteFile.isFolder &&
        snapshotLocalIndex.folderSet.has(remoteFile.path) &&
        !currentLocalIndex.folderSet.has(remoteFile.path)
      ) {
        locallyDeletedFolders.add(remoteFile.path);
        changes.push(
          createChange({
            changeType: ChangeType.LOCAL_DELETED,
            path: remoteFile.path,
            fileId: remoteFile.id,
            remoteMeta: remoteFile,
            snapshotMeta: snapshotEntry,
          })
        );
        continue;
      }

      // The remote entry was snapshotted without a matching local entry.
      // Treat it as pending download so a partial local tree can self-heal.
      if (remoteFile.isFolder && localFolderPaths.has(remoteFile.path)) {
        continue;
      }

      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_ADDED,
          path: remoteFile.path,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
          snapshotMeta: snapshotEntry,
        })
      );
      continue;
    }

    const localMeta = localFilesData[remoteFile.path];
    remoteBaselinePathsHandledLocally.add(remoteFile.path);

    if (!remoteAndLocalEquivalent(remoteFile, localMeta)) {
      changes.push(
        createChange({
          changeType: ChangeType.CONFLICT,
          path: remoteFile.path,
          fileId: remoteFile.id,
          remoteMeta: remoteFile,
          localMeta,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  // Detect remote deletions — snapshot entries missing from remote
  const remoteDeletedFoldersByPath = new Set();
  for (const fileId of Object.keys(snapshotFiles)) {
    if (!remoteById.has(fileId)) {
      const snapshotEntry = snapshotFiles[fileId];
      const snapshotPath = snapshotEntry.path || snapshotEntry.localPath || "";

      if (remoteDeletedFoldersByPath.has(snapshotPath) || isUnderAnyFolder(snapshotPath, remoteDeletedFoldersByPath)) {
        continue;
      }

      // Same path with a different Drive ID is a remote replacement, not a
      // deletion of the local path.
      if (snapshotPath && remoteByPath.has(snapshotPath)) {
        continue;
      }

      // Skip folder deletion if the folder still implicitly exists on Drive
      // (e.g. it became non-empty, or was recreated with a different ID)
      if (snapshotEntry.isFolder && remoteFolderPaths.has(snapshotPath)) {
        continue;
      }

      const hadLocalBaseline = Object.prototype.hasOwnProperty.call(
        snapshotLocalFiles,
        snapshotPath
      );
      const missingLocally = !Object.prototype.hasOwnProperty.call(
        localFilesData,
        snapshotPath
      );
      if (hadLocalBaseline && missingLocally) {
        continue;
      }

      const remoteDeletePath = snapshotEntry.isFolder
        ? null
        : remotelyDeletedAncestorPath(
          snapshotPath,
          snapshotRemoteIndex,
          currentRemoteIndex,
          localFolderPaths
        );
      if (remoteDeletePath) {
        remoteDeletedFoldersByPath.add(remoteDeletePath);
        const remoteFolder = snapshotRemoteByPath.get(remoteDeletePath);
        changes.push(
          createChange({
            changeType: ChangeType.REMOTE_DELETED,
            path: remoteDeletePath,
            fileId: remoteFolder?.fileId || null,
            snapshotMeta: folderSnapshotMeta(remoteDeletePath, snapshotRemoteByPath),
          })
        );
        continue;
      }

      if (snapshotEntry.isFolder && snapshotPath) {
        remoteDeletedFoldersByPath.add(snapshotPath);
      }

      changes.push(
        createChange({
          changeType: ChangeType.REMOTE_DELETED,
          path: snapshotPath,
          fileId,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  // A folder that contains files has no explicit entry on either side of the
  // snapshot: remote listings and local scans only record empty folders.
  // Deleting such a folder locally would therefore only surface its files,
  // and trashing those one by one leaves an empty folder husk behind on
  // Drive that the next sync resurrects locally. Surface the topmost deleted
  // folder itself so the whole remote tree is trashed with it.
  const remoteOccupiedIndex = indexPathsForAncestry(
    changes
      .filter(
        (change) =>
          change.changeType === ChangeType.REMOTE_ADDED ||
          change.changeType === ChangeType.REMOTE_MODIFIED ||
          change.changeType === ChangeType.REMOTE_RENAMED ||
          change.changeType === ChangeType.CONFLICT
      )
      .map((change) => change.path)
  );
  for (const folderPath of [...snapshotLocalIndex.folderSet].sort(
    (left, right) =>
      left.split("/").length - right.split("/").length ||
      left.localeCompare(right)
  )) {
    if (
      locallyDeletedFolders.has(folderPath) ||
      isUnderAnyFolder(folderPath, locallyDeletedFolders)
    ) {
      continue;
    }
    // Only a folder that vanished locally in full counts as deleted.
    if (hasPathOrDescendant(currentLocalIndex, folderPath)) continue;
    // Nothing to delete when the folder is gone from Drive as well.
    if (!remoteFolderPaths.has(folderPath)) continue;
    // A locally renamed folder is missing from its old path by design.
    if (isRenamedDescendant(folderPath, localPathRenames)) continue;
    // Remote-side changes underneath (edits, additions, renames, conflicts)
    // must win over the folder deletion — they resolve at the file level.
    if (hasPathOrDescendant(remoteOccupiedIndex, folderPath)) continue;

    locallyDeletedFolders.add(folderPath);
    // Trashing this folder covers every deletion already collapsed beneath it.
    const subtreePrefix = `${folderPath}/`;
    for (let index = changes.length - 1; index >= 0; index--) {
      if (
        changes[index].changeType === ChangeType.LOCAL_DELETED &&
        changes[index].path.startsWith(subtreePrefix)
      ) {
        changes.splice(index, 1);
      }
    }
    const remoteFolder = remoteByPath.get(folderPath);
    changes.push(
      createChange({
        changeType: ChangeType.LOCAL_DELETED,
        path: folderPath,
        fileId:
          remoteFolder?.id || snapshotRemoteByPath.get(folderPath)?.fileId || null,
        remoteMeta: remoteFolder || null,
        snapshotMeta: folderSnapshotMeta(folderPath, snapshotRemoteByPath),
      })
    );
  }

  const localRenameTargets = new Set(
    locallyRenamedFolders.map((rename) => rename.to)
  );
  for (const [relativePath, localMeta] of Object.entries(localFilesData)) {
    const remappedLocalPath = remapRenamedLocalPath(relativePath, localPathRenames);
    if (
      remappedLocalPath !== relativePath &&
      Object.prototype.hasOwnProperty.call(snapshotLocalFiles, remappedLocalPath)
    ) {
      // The path change is covered by the folder rename, but a content
      // change made alongside it must still be staged for upload.
      const renamedSnapshotEntry = snapshotLocalFiles[remappedLocalPath];
      if (!localChanged(renamedSnapshotEntry, localMeta)) {
        continue;
      }
      const remoteEntry = snapshotRemoteByPath.get(remappedLocalPath);
      const currentRemote = remoteEntry ? remoteById.get(remoteEntry.fileId) : null;
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_MODIFIED,
          path: relativePath,
          fileId: remoteEntry?.fileId || null,
          localMeta,
          remoteMeta: currentRemote || null,
          snapshotMeta: renamedSnapshotEntry,
        })
      );
      continue;
    }
    if (remoteBaselinePathsHandledLocally.has(relativePath)) {
      continue;
    }

    const snapshotEntry = snapshotLocalFiles[relativePath];

    if (!snapshotEntry) {
      if (
        localMeta.isFolder &&
        (remoteDeletedFoldersByPath.has(relativePath) ||
          isUnderAnyFolder(relativePath, remoteDeletedFoldersByPath))
      ) {
        continue;
      }

      // Skip local folder if it already exists on Drive (as parent or explicit dir)
      if (localMeta.isFolder && remoteFolderPaths.has(relativePath)) {
        continue;
      }
      // The destination of a local folder rename is handled by the staged
      // rename itself — creating it again would duplicate the folder.
      if (localMeta.isFolder && localRenameTargets.has(relativePath)) {
        continue;
      }
      // Paths inside a remotely renamed folder move with the staged local
      // move. Folders (and files Drive already has at the renamed location)
      // need no change; a genuinely new file must upload to the folder's
      // NEW remote path, not recreate the old one.
      const remoteRenameAdjustedPath = applyLocalFolderRenames(
        relativePath,
        remotePathRenames
      );
      if (remoteRenameAdjustedPath !== relativePath) {
        if (localMeta.isFolder || remoteByPath.has(remoteRenameAdjustedPath)) {
          continue;
        }
        changes.push(
          createChange({
            changeType: ChangeType.LOCAL_ADDED,
            path: relativePath,
            localMeta,
            remoteMeta: { path: remoteRenameAdjustedPath },
          })
        );
        continue;
      }
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_ADDED,
          path: relativePath,
          localMeta,
        })
      );
      continue;
    }

    if (localChanged(snapshotEntry, localMeta)) {
      const remoteEntry = snapshotRemoteByPath.get(relativePath);
      // Attach the file's current remote entry so a staged upload targets the
      // file's actual location on Drive even after a remote folder rename.
      const currentRemote = remoteEntry ? remoteById.get(remoteEntry.fileId) : null;
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_MODIFIED,
          path: relativePath,
          fileId: remoteEntry?.fileId || null,
          localMeta,
          remoteMeta: currentRemote || null,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  for (const [relativePath, snapshotEntry] of Object.entries(snapshotLocalFiles)) {
    if (isRenamedDescendant(relativePath, localPathRenames)) {
      continue;
    }
    if (!(relativePath in localFilesData)) {
      if (
        locallyDeletedFolders.has(relativePath) ||
        isUnderAnyFolder(relativePath, locallyDeletedFolders)
      ) {
        continue;
      }

      // Skip folder deletion if the folder still implicitly exists locally
      if (snapshotEntry.isFolder && localFolderPaths.has(relativePath)) {
        continue;
      }
      const remoteEntry = snapshotRemoteByPath.get(relativePath);
      const remoteAlsoDeleted =
        remoteEntry &&
        !remoteById.has(remoteEntry.fileId) &&
        !remoteByPath.has(relativePath) &&
        !(snapshotEntry.isFolder && remoteFolderPaths.has(relativePath));
      if (remoteAlsoDeleted) {
        continue;
      }
      changes.push(
        createChange({
          changeType: ChangeType.LOCAL_DELETED,
          path: relativePath,
          fileId: remoteEntry?.fileId || null,
          snapshotMeta: snapshotEntry,
        })
      );
    }
  }

  // Compute pack changes
  const packChanges = computePackChanges(root, packedDirs, snapshot);

  return buildDiffResult(
    promoteConflicts(
      promoteCrossPathModifyConflicts(
        promoteRenameDeleteConflicts(changes, snapshotFiles, remoteFiles, localFilesData)
      )
    ),
    packChanges
  );
}
