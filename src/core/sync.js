import fs from "node:fs";
import path from "node:path";
import { readConfig, readIndex, readLatestSnapshot, writeIndex } from "./config.js";
import {
  downloadFile,
  ensureFolder,
  findRemoteItemByPath,
  trashFile,
  uploadFile,
} from "./drive-api.js";
import { pullPack, pushPack } from "./pack-sync.js";
import { md5Local } from "./snapshot.js";

function readPositiveIntEnv(name, fallback) {
  const rawValue = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : fallback;
}

const CONCURRENCY = readPositiveIntEnv(
  "AETHEL_TRANSFER_CONCURRENCY",
  readPositiveIntEnv("AETHEL_DRIVE_CONCURRENCY", 32)
);
const CHILD_INDEX_UPLOAD_THRESHOLD = readPositiveIntEnv(
  "AETHEL_CHILD_INDEX_UPLOAD_THRESHOLD",
  3
);

function isMissingLocalFileError(err) {
  return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

function toLocalAbsolutePath(root, relativePath) {
  const abs = path.resolve(root, ...relativePath.split("/"));
  const resolvedRoot = path.resolve(root);
  if (!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) {
    throw new Error(`Path traversal blocked: ${relativePath} resolves outside workspace`);
  }
  return abs;
}

function createTransferContext(staged) {
  const uploadParentCounts = new Map();

  for (const entry of staged) {
    if (entry.action !== "upload" || entry.isFolder) {
      continue;
    }
    const remotePath = entry.remotePath || entry.path;
    const parentPath = path.posix.dirname(remotePath);
    const normalizedParentPath = parentPath && parentPath !== "." ? parentPath : "";
    uploadParentCounts.set(
      normalizedParentPath,
      (uploadParentCounts.get(normalizedParentPath) || 0) + 1
    );
  }

  return {
    childIndexCache: new Map(),
    folderIdByPath: new Map(),
    uploadParentCounts,
  };
}

function transferFolderCacheKey(rootId, folderPath) {
  return `${rootId || "root"}\0${folderPath || ""}`;
}

async function ensureFolderCached(drive, folderPath, rootId, context) {
  if (!folderPath || folderPath === ".") {
    return rootId || "root";
  }

  if (!context?.folderIdByPath) {
    return ensureFolder(drive, folderPath, rootId);
  }

  const cacheKey = transferFolderCacheKey(rootId, folderPath);
  let pending = context.folderIdByPath.get(cacheKey);
  if (!pending) {
    pending = ensureFolder(drive, folderPath, rootId);
    context.folderIdByPath.set(cacheKey, pending);
  }
  return pending;
}

function snapshotFileMeta(snapshot, fileId) {
  if (!fileId) {
    return null;
  }
  return snapshot?.files?.[fileId] || null;
}

export class CommitResult {
  constructor() {
    this.downloaded = 0;
    this.uploaded = 0;
    this.deletedLocal = 0;
    this.deletedRemote = 0;
    this.foldersCreated = 0;
    this.foldersRenamed = 0;
    this.packsPushed = 0;
    this.packsPulled = 0;
    this.errors = [];
  }

  get total() {
    return (
      this.downloaded +
      this.uploaded +
      this.deletedLocal +
      this.deletedRemote +
      this.foldersCreated +
      this.foldersRenamed +
      this.packsPushed +
      this.packsPulled
    );
  }

  get summary() {
    const parts = [];

    if (this.downloaded) {
      parts.push(`${this.downloaded} downloaded`);
    }
    if (this.uploaded) {
      parts.push(`${this.uploaded} uploaded`);
    }
    if (this.foldersCreated) {
      parts.push(`${this.foldersCreated} folders created`);
    }
    if (this.foldersRenamed) {
      parts.push(`${this.foldersRenamed} folders renamed`);
    }
    if (this.packsPushed) {
      parts.push(`${this.packsPushed} packs pushed`);
    }
    if (this.packsPulled) {
      parts.push(`${this.packsPulled} packs pulled`);
    }
    if (this.deletedLocal) {
      parts.push(`${this.deletedLocal} deleted locally`);
    }
    if (this.deletedRemote) {
      parts.push(`${this.deletedRemote} deleted on Drive`);
    }
    if (this.errors.length) {
      parts.push(`${this.errors.length} errors`);
    }

    return parts.length ? parts.join(", ") : "nothing to do";
  }
}

async function downloadStagedFile(drive, entry, root, snapshot = null) {
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  // Empty folder: just create the directory locally
  if (entry.isFolder) {
    fs.mkdirSync(localAbsolutePath, { recursive: true });
    return;
  }

  const fileId = entry.fileId;
  const snapMeta = snapshotFileMeta(snapshot, fileId);
  let fileMeta = {
    id: fileId,
    name: path.posix.basename(
      entry.remotePath || entry.path || snapMeta?.path || fileId
    ),
    mimeType: entry.remoteMimeType || snapMeta?.mimeType || "",
    md5Checksum: entry.remoteMd5Checksum || snapMeta?.md5Checksum || null,
  };

  if (!fileMeta.mimeType && !fileMeta.md5Checksum) {
    const response = await drive.files.get({
      fileId,
      fields: "id,name,mimeType,md5Checksum",
    });
    fileMeta = { ...response.data, id: fileId };
  }

  await downloadFile(drive, fileMeta, localAbsolutePath);
}

async function handleMissingUploadSource(drive, entry, snapshot, driveFolderId) {
  const deleted = await deleteRemoteFile(drive, entry, snapshot, driveFolderId);
  return deleted ? "deleted_remote" : "skipped";
}

async function uploadStagedFile(drive, entry, root, driveFolderId, snapshot, context = null) {
  const localRelativePath = entry.localPath || entry.path;
  const remotePath = entry.remotePath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  let localStat;
  try {
    localStat = await fs.promises.lstat(localAbsolutePath);
  } catch (err) {
    if (isMissingLocalFileError(err)) {
      return handleMissingUploadSource(drive, entry, snapshot, driveFolderId);
    }
    throw err;
  }

  // Empty folder: just ensure it exists on Drive
  if (entry.isFolder || localStat.isDirectory()) {
    await ensureFolderCached(drive, remotePath, driveFolderId, context);
    return "folder_created";
  }

  const parentPath = path.posix.dirname(remotePath);
  let parentId = driveFolderId || "root";
  let childIndexCache = null;

  if (parentPath && parentPath !== ".") {
    parentId = await ensureFolderCached(drive, parentPath, driveFolderId, context);
  }

  const normalizedParentPath = parentPath && parentPath !== "." ? parentPath : "";
  if (
    context?.uploadParentCounts?.get(normalizedParentPath) >=
    CHILD_INDEX_UPLOAD_THRESHOLD
  ) {
    childIndexCache = context.childIndexCache;
  }

  let uploadResult;
  try {
    uploadResult = await uploadFile(drive, localAbsolutePath, remotePath, {
      parentId,
      existingId: entry.fileId || null,
      cleanupDuplicates: true,
      childIndexCache,
    });
  } catch (err) {
    if (isMissingLocalFileError(err)) {
      return handleMissingUploadSource(drive, entry, snapshot, driveFolderId);
    }
    throw err;
  }

  // Verify: Drive-returned md5 must match the local file we just uploaded.
  // Google Workspace files (Docs, Sheets, etc.) don't have md5 — skip them.
  if (uploadResult?.md5Checksum) {
    const currentModifiedTime = new Date(localStat.mtimeMs).toISOString();
    let postUploadStat;
    try {
      postUploadStat = await fs.promises.lstat(localAbsolutePath);
    } catch (err) {
      if (isMissingLocalFileError(err)) {
        return "uploaded";
      }
      throw err;
    }
    const fileStableDuringUpload =
      postUploadStat.size === localStat.size &&
      postUploadStat.mtimeMs === localStat.mtimeMs;
    const stagedMetadataMatches =
      entry.localMd5 &&
      entry.localSize === localStat.size &&
      entry.localModifiedTime === currentModifiedTime &&
      fileStableDuringUpload;

    let localMd5 = stagedMetadataMatches ? entry.localMd5 : null;
    // The upload already hashed every byte it sent, so a file that did not
    // move under us needs no second full read to verify. A file that did
    // change still gets re-hashed, so an edit mid-upload fails the commit as
    // before rather than being papered over.
    if (!localMd5 && fileStableDuringUpload && uploadResult.aethelStreamMd5) {
      localMd5 = uploadResult.aethelStreamMd5;
    }
    if (!localMd5) {
      try {
        localMd5 = await md5Local(localAbsolutePath);
      } catch (err) {
        if (isMissingLocalFileError(err)) {
          return "uploaded";
        }
        throw err;
      }
    }
    if (localMd5 !== uploadResult.md5Checksum) {
      throw new Error(
        `Upload integrity check failed for ${remotePath}: ` +
        `local md5 ${localMd5}, Drive returned ${uploadResult.md5Checksum}`
      );
    }
  }

  return "uploaded";
}

async function deleteLocalFile(entry, root) {
  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  let stat;
  try {
    stat = await fs.promises.lstat(localAbsolutePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return;
    }
    throw err;
  }

  if (stat.isDirectory()) {
    if (entry.recursiveLocalDelete) {
      await fs.promises.rm(localAbsolutePath, { recursive: true, force: false });
      return;
    }

    await fs.promises.rmdir(localAbsolutePath);
    return;
  }

  await fs.promises.unlink(localAbsolutePath);

  // Clean up empty parent directories up to workspace root
  let currentPath = path.dirname(localAbsolutePath);
  const resolvedRoot = path.resolve(root);

  while (currentPath !== resolvedRoot) {
    try {
      const contents = await fs.promises.readdir(currentPath);
      if (contents.length > 0) break;
      await fs.promises.rmdir(currentPath);
    } catch {
      break;
    }
    currentPath = path.dirname(currentPath);
  }
}

async function moveLocalFolder(entry, root) {
  const sourcePath = entry.sourcePath;
  if (!sourcePath) throw new Error("Missing source path for local folder move");
  const source = toLocalAbsolutePath(root, sourcePath);
  const destination = toLocalAbsolutePath(root, entry.localPath || entry.path);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.rename(source, destination);
}

function localMoveDestinationBeforeAncestorMoves(entry, localMoves) {
  const sourcePath = entry.sourcePath;
  let destinationPath = entry.localPath || entry.path;

  if (!sourcePath) {
    return destinationPath;
  }

  const ancestorMoves = localMoves
    .map(({ entry: candidate }) => candidate)
    .filter(
      (candidate) =>
        candidate.sourcePath &&
        sourcePath.startsWith(`${candidate.sourcePath}/`)
    )
    .sort(
      (left, right) =>
        (right.localPath || right.path).split("/").length -
        (left.localPath || left.path).split("/").length
    );

  for (const ancestor of ancestorMoves) {
    const ancestorDestination = ancestor.localPath || ancestor.path;
    if (destinationPath === ancestorDestination) {
      destinationPath = ancestor.sourcePath;
    } else if (destinationPath.startsWith(`${ancestorDestination}/`)) {
      destinationPath = `${ancestor.sourcePath}${destinationPath.slice(
        ancestorDestination.length
      )}`;
    }
  }

  return destinationPath;
}

async function renameRemoteFolder(drive, entry, driveFolderId) {
  let fileId = entry.fileId;

  // Non-empty folders carry no ID through the remote listing; resolve the
  // folder by its current (pre-rename) remote path instead.
  if (!fileId) {
    const remoteItem = await findRemoteItemByPath(
      drive,
      entry.sourcePath || entry.remotePath || entry.path,
      driveFolderId
    );
    fileId = remoteItem?.id || null;
  }

  if (!fileId) {
    throw new Error(
      `Remote folder not found for rename: ${entry.sourcePath || entry.path}`
    );
  }

  await drive.files.update({
    fileId,
    requestBody: { name: path.posix.basename(entry.remotePath || entry.path) },
    fields: "id,name",
  });
}

function remapPathAfterRename(pathValue, fromPath, toPath) {
  if (!pathValue || !fromPath || !toPath || fromPath === toPath) {
    return pathValue;
  }
  if (pathValue === fromPath) {
    return toPath;
  }
  if (pathValue.startsWith(`${fromPath}/`)) {
    return `${toPath}${pathValue.slice(fromPath.length)}`;
  }
  return pathValue;
}

async function cleanupEmptyParentDirectories(root, relativePath) {
  let currentPath = path.dirname(toLocalAbsolutePath(root, relativePath));
  const resolvedRoot = path.resolve(root);

  while (currentPath !== resolvedRoot) {
    try {
      const contents = await fs.promises.readdir(currentPath);
      if (contents.length > 0) break;
      await fs.promises.rmdir(currentPath);
    } catch {
      break;
    }
    currentPath = path.dirname(currentPath);
  }
}

async function isLocalDirectoryEntry(entry, root) {
  if (entry.isFolder) {
    return true;
  }

  const localRelativePath = entry.localPath || entry.path;
  const localAbsolutePath = toLocalAbsolutePath(root, localRelativePath);

  try {
    return (await fs.promises.lstat(localAbsolutePath)).isDirectory();
  } catch (err) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function findSnapshotFileIdByPath(snapshot, entry) {
  const targetPaths = new Set(
    [entry.remotePath, entry.path, entry.localPath].filter(Boolean)
  );

  for (const [fileId, snapshotEntry] of Object.entries(snapshot?.files || {})) {
    if (
      targetPaths.has(snapshotEntry.path) ||
      targetPaths.has(snapshotEntry.localPath)
    ) {
      return fileId;
    }
  }

  return null;
}

async function findRemoteFileId(drive, entry, snapshot, driveFolderId) {
  const snapshotFileId = entry.fileId || findSnapshotFileIdByPath(snapshot, entry);
  if (snapshotFileId) {
    return snapshotFileId;
  }

  const remotePath = entry.remotePath || entry.path || entry.localPath;
  const remoteItem = await findRemoteItemByPath(drive, remotePath, driveFolderId);
  return remoteItem?.id || null;
}

async function deleteRemoteFile(drive, entry, snapshot, driveFolderId) {
  const fileId = await findRemoteFileId(drive, entry, snapshot, driveFolderId);

  if (!fileId) {
    return false;
  }

  await trashFile(drive, fileId);
  return true;
}

// ── Bounded-concurrency runner ───────────────────────────────────────

/**
 * Scheduling weight for a staged remote operation — higher starts sooner.
 * Metadata-only work and packs of unknown size go first, then real transfers
 * ordered by how long they are likely to occupy a slot.
 */
function remoteOpWeight(entry) {
  if (entry.isFolder) return Number.POSITIVE_INFINITY;
  if (entry.action === "delete_remote") return Number.POSITIVE_INFINITY;
  if (entry.action === "push_pack" || entry.action === "pull_pack") {
    return Number.POSITIVE_INFINITY;
  }
  const size = entry.localSize ?? entry.remoteSize;
  return Number.isFinite(size) ? size : 0;
}

async function runConcurrent(tasks, limit, onDone) {
  let next = 0;
  let running = 0;
  let done = 0;

  return new Promise((resolve, reject) => {
    function launch() {
      while (running < limit && next < tasks.length) {
        const index = next++;
        running++;
        tasks[index]()
          .then((result) => {
            running--;
            done++;
            onDone?.(done, tasks.length, index, null, result);
            if (done === tasks.length) resolve();
            else launch();
          })
          .catch((err) => {
            running--;
            done++;
            onDone?.(done, tasks.length, index, err, null);
            if (done === tasks.length) resolve();
            else launch();
          });
      }
    }
    if (tasks.length === 0) resolve();
    else launch();
  });
}

// ── Main executor ────────────────────────────────────────────────────

export async function executeStaged(drive, root, progress) {
  const config = readConfig(root);
  const index = readIndex(root);
  const staged = index.staged || [];
  const snapshot = readLatestSnapshot(root);
  const driveFolderId = config.drive_folder_id || null;
  const result = new CommitResult();
  const transferContext = createTransferContext(staged);

  // Local deletes can run fully in parallel — no API rate limits.
  // Remote operations (download, upload, delete_remote) share a concurrency pool.
  const localDeletes = [];
  const localMoves = [];
  const remoteRenames = [];
  const remoteOps = [];
  const failedPaths = new Set();

  for (const [i, entry] of staged.entries()) {
    if (entry.action === "delete_local") {
      localDeletes.push({ index: i, entry });
    } else if (entry.action === "move_local") {
      localMoves.push({ index: i, entry });
    } else if (entry.action === "rename_remote") {
      remoteRenames.push({ index: i, entry });
    } else {
      remoteOps.push({ index: i, entry });
    }
  }

  // Rename existing Drive folders before uploads into their new local paths.
  // Deepest first, matching how nested local moves are ordered.
  remoteRenames.sort(
    (left, right) =>
      (right.entry.sourcePath || right.entry.path).split("/").length -
      (left.entry.sourcePath || left.entry.path).split("/").length
  );
  for (const { entry } of remoteRenames) {
    try {
      await renameRemoteFolder(drive, entry, driveFolderId);
      result.foldersRenamed++;
    } catch (err) {
      failedPaths.add(entry.path);
      result.errors.push(`rename_remote ${entry.path}: ${err.message}`);
    }
  }

  // A successful remote rename moved every remote descendant with it — remap
  // pending remote targets so uploads land in the renamed folder instead of
  // recreating the old one.
  for (const { entry: rename } of remoteRenames) {
    if (failedPaths.has(rename.path) || !rename.sourcePath) continue;
    const renameTargetPath = rename.remotePath || rename.path;
    for (const { entry } of remoteOps) {
      const remapped = remapPathAfterRename(
        entry.remotePath || entry.path,
        rename.sourcePath,
        renameTargetPath
      );
      if (remapped !== (entry.remotePath || entry.path)) {
        entry.remotePath = remapped;
      }
    }
  }

  // Moves must finish before any descendant remote operations use their new path.
  // Nested folder renames must move the deepest directory first: after an
  // ancestor moves, its old descendant source path no longer exists.
  localMoves.sort(
    (left, right) =>
      (right.entry.sourcePath || right.entry.path).split("/").length -
      (left.entry.sourcePath || left.entry.path).split("/").length
  );
  for (const { entry } of localMoves) {
    try {
      await moveLocalFolder(
        {
          ...entry,
          localPath: localMoveDestinationBeforeAncestorMoves(entry, localMoves),
        },
        root
      );
    } catch (err) {
      failedPaths.add(entry.path);
      result.errors.push(`move_local ${entry.path}: ${err.message}`);
    }
  }

  // A successful move relocated every local descendant with it — remap
  // pending local paths so later uploads and deletes find their files at the
  // moved location instead of treating them as missing (which would trash
  // the remote copy). Applied in executed (deepest-source-first) order so
  // nested moves compose to each entry's final path.
  for (const { entry: move } of localMoves) {
    if (failedPaths.has(move.path) || !move.sourcePath) continue;
    const moveDestination = move.localPath || move.path;
    for (const { entry } of [...remoteOps, ...localDeletes]) {
      const remapped = remapPathAfterRename(
        entry.localPath || entry.path,
        move.sourcePath,
        moveDestination
      );
      if (remapped !== (entry.localPath || entry.path)) {
        entry.localPath = remapped;
      }
    }
  }

  // Run local file deletes before folder deletes so a remote-deleted tree can
  // be removed without reporting non-empty folders as successful deletions.
  // Older staged entries may not carry isFolder, so classify from disk too.
  const localFileDeletes = [];
  const localFolderDeletes = [];
  for (const localDelete of localDeletes) {
    if (await isLocalDirectoryEntry(localDelete.entry, root)) {
      localFolderDeletes.push(localDelete);
    } else {
      localFileDeletes.push(localDelete);
    }
  }
  localFolderDeletes.sort(
    (left, right) => right.entry.path.split("/").length - left.entry.path.split("/").length
  );

  await Promise.all(
    localFileDeletes.map(async ({ entry }) => {
      try {
        await deleteLocalFile(entry, root);
        result.deletedLocal++;
      } catch (err) {
        failedPaths.add(entry.path);
        result.errors.push(`delete_local ${entry.path}: ${err.message}`);
      }
    })
  );

  const successfulLocalFileDeletes = localFileDeletes
    .filter(({ entry }) => !failedPaths.has(entry.path))
    .sort((left, right) => right.entry.path.split("/").length - left.entry.path.split("/").length);
  for (const { entry } of successfulLocalFileDeletes) {
    await cleanupEmptyParentDirectories(root, entry.localPath || entry.path);
  }

  for (const { entry } of localFolderDeletes) {
    try {
      await deleteLocalFile(entry, root);
      result.deletedLocal++;
    } catch (err) {
      failedPaths.add(entry.path);
      result.errors.push(`delete_local ${entry.path}: ${err.message}`);
    }
  }

  // Fill the pool largest-first. A FIFO pool that happens to start a multi-GB
  // file last leaves it transferring alone long after every other slot has
  // drained; starting it first overlaps it with all the small work. Metadata-
  // only operations sort ahead of everything: they finish almost immediately
  // and folder creation warms the shared folder cache for concurrent uploads.
  // The sort is stable, so entries of equal weight keep their staged order.
  remoteOps.sort(
    (left, right) => remoteOpWeight(right.entry) - remoteOpWeight(left.entry)
  );

  // Run remote operations with bounded concurrency
  const tasks = remoteOps.map(({ entry }) => {
    return async () => {
      const action = entry.action;
      if (action === "download") {
        await downloadStagedFile(drive, entry, root, snapshot);
        if (entry.isFolder) result.foldersCreated++;
        else result.downloaded++;
      } else if (action === "upload") {
        const outcome = await uploadStagedFile(
          drive,
          entry,
          root,
          driveFolderId,
          snapshot,
          transferContext
        );
        if (outcome === "folder_created") result.foldersCreated++;
        else if (outcome === "uploaded") result.uploaded++;
        else if (outcome === "deleted_remote") result.deletedRemote++;
      } else if (action === "delete_remote") {
        const deleted = await deleteRemoteFile(drive, entry, snapshot, driveFolderId);
        if (deleted) result.deletedRemote++;
      } else if (action === "push_pack") {
        await pushPack(drive, root, entry.path);
        result.packsPushed++;
      } else if (action === "pull_pack") {
        await pullPack(drive, root, entry.path);
        result.packsPulled++;
      } else {
        throw new Error(`Unknown action '${action}'`);
      }
      return entry;
    };
  });

  let completed = localDeletes.length + localMoves.length + remoteRenames.length;
  await runConcurrent(tasks, CONCURRENCY, (done, total, idx, err, entry) => {
    completed++;
    const op = remoteOps[idx];
    if (err) {
      failedPaths.add(op.entry.path);
      result.errors.push(`${op.entry.action} ${op.entry.path}: ${err.message}`);
    }
    progress?.(completed - 1, staged.length, op.entry.action, path.posix.basename(op.entry.path || ""));
  });

  progress?.(staged.length, staged.length, "done", "");

  // Only clear succeeded entries — keep failed ones staged for retry
  if (failedPaths.size > 0) {
    index.staged = staged.filter((e) => failedPaths.has(e.path));
  } else {
    index.staged = [];
  }
  writeIndex(root, index);

  return result;
}
