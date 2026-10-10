import fs from "node:fs";
import path from "node:path";
import { readConfig, readIndex, readLatestSnapshot, writeIndex } from "./config.js";
import {
  downloadFile,
  ensureFolder,
  findRemoteItemByPath,
  resetFolderLookupCache,
  trashFile,
  uploadFile,
} from "./drive-api.js";
import { pullPack, pushPack } from "./pack-sync.js";
import { md5Local, scanLocal } from "./snapshot.js";
import { logEvent, withRunLog } from "./logger.js";
import { openExecutionJournal, operationKey } from "./execution-journal.js";
import { withWorkspaceLock } from "./workspace-lock.js";

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

async function downloadStagedFile(drive, entry, root, snapshot = null, guard = null) {
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

  await downloadFile(drive, fileMeta, localAbsolutePath, {
    guardReplace: guard
      ? (targetPath, downloadedMd5) =>
        guard.assertDownloadReplaceable(
          entry,
          targetPath,
          downloadedMd5 || fileMeta.md5Checksum || null
        )
      : null,
  });
}

async function handleMissingUploadSource(drive, entry, snapshot, driveFolderId) {
  // A source disappearing after staging invalidates the upload. It is not
  // authorization to delete the remote object, which may have changed too.
  throw Object.assign(new Error(`Upload source disappeared: ${entry.localPath || entry.path}. Refresh the sync plan.`), {
    code: "SOURCE_CHANGED",
  });
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

async function deleteLocalFile(entry, root, guard = null) {
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
    } else {
      await fs.promises.rmdir(localAbsolutePath);
    }
    // Only entries that know which ancestors Drive keeps prune upward; a bare
    // folder delete has never emptied its parents on its own.
    if (typeof entry.retainDirectory === "string") {
      await cleanupEmptyParentDirectories(root, localRelativePath, entry.retainDirectory);
    }
    return;
  }

  await guard?.assertFileDeletable(entry, localAbsolutePath, stat);
  try {
    await fs.promises.unlink(localAbsolutePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err; // removed since the check: same outcome
  }
  await cleanupEmptyParentDirectories(root, localRelativePath, entry.retainDirectory);
}

const UNSYNCED_PREVIEW_LIMIT = 5;

function localWorkAtRisk(message) {
  return Object.assign(new Error(message), { code: "LOCAL_WORK_AT_RISK" });
}

/**
 * Guards for local deletes that apply a deletion made on Drive. Such a delete
 * is only safe for a file Drive has, unchanged since the last sync: anything
 * else — a file Drive never received, an edit it has not seen — exists nowhere
 * else once it is gone. The plan checked this when it was made, but staged
 * entries outlive their plan and files change in between, so verify again
 * against the baseline right before deleting.
 *
 * Without a baseline there is nothing to compare against and the delete is
 * allowed, as before. The check and the delete are separate steps, so an edit
 * landing in between is still possible; the window is a few milliseconds.
 */
function createLocalWorkGuard(root, snapshot) {
  // The baseline records the files Drive has, as of the last sync, by path.
  let syncedByPath = null;
  const synced = () => {
    if (!syncedByPath) {
      syncedByPath = new Map();
      for (const meta of Object.values(snapshot?.files || {})) {
        if (meta.path) syncedByPath.set(meta.path, meta);
        if (meta.localPath) syncedByPath.set(meta.localPath, meta);
      }
    }
    return syncedByPath;
  };
  const tracked = () => synced();
  const hashOrNull = async (absolutePath) => {
    try {
      return await md5Local(absolutePath);
    } catch (err) {
      if (isMissingLocalFileError(err)) return null;
      throw err;
    }
  };
  /** True when size and modification time are those recorded at the last sync. */
  const matchesBaselineStat = (stat, baseline) =>
    stat.size === baseline.size &&
    new Date(stat.mtimeMs).toISOString() === baseline.modifiedTime;

  // One scan per run (ignore rules and packed directories apply, exactly as for
  // diffing), and only when a recursive delete needs it.
  let scanned = null;
  const scanOnce = () => (scanned ??= scanLocal(root).then((scan) => scan.files));

  return {
    /** A recursive folder delete takes every local file under the folder. */
    async assertFolderDeletable(entry) {
      if (!snapshot) return;

      const folderPath = entry.localPath || entry.path;
      const atRisk = [];
      for (const [filePath, meta] of Object.entries(await scanOnce())) {
        if (meta.isFolder || !filePath.startsWith(`${folderPath}/`)) continue;
        const baseline = snapshot.localFiles?.[filePath];
        if (!tracked().has(filePath) || !baseline || baseline.md5 !== meta.md5) {
          atRisk.push(filePath);
        }
      }
      if (atRisk.length === 0) return;

      const shown = atRisk.slice(0, UNSYNCED_PREVIEW_LIMIT).join(", ");
      const more = atRisk.length > UNSYNCED_PREVIEW_LIMIT
        ? ` (+${atRisk.length - UNSYNCED_PREVIEW_LIMIT} more)`
        : "";
      throw localWorkAtRisk(
        `Refusing to delete ${folderPath}: it holds local files Drive does not have ` +
        `as they are now: ${shown}${more}. Push or move them, then pull again.`
      );
    },

    /**
     * A single-file delete. The baseline is keyed by the path the plan named
     * (`entry.path`); `absolutePath` is where the file is now, which differs
     * after an ancestor folder was moved earlier in the same run.
     */
    async assertFileDeletable(entry, absolutePath, stat) {
      if (!snapshot?.localFiles) return;

      const baselinePath = entry.path;
      const baseline = snapshot.localFiles[baselinePath];
      if (!baseline || !tracked().has(baselinePath)) {
        throw localWorkAtRisk(
          `Refusing to delete ${baselinePath}: Drive has no record of this file, ` +
          `so deleting it would lose the only copy. Push it or move it away, then pull again.`
        );
      }

      // Same size and modification time as at the last sync is how the scanner
      // already decides a file is unchanged; only a file that moved is re-read.
      if (matchesBaselineStat(stat, baseline)) return;

      const currentMd5 = await hashOrNull(absolutePath);
      if (currentMd5 === null) return; // already gone
      if (currentMd5 !== baseline.md5) {
        throw localWorkAtRisk(
          `Refusing to delete ${baselinePath}: it changed locally since the last sync. ` +
          `Push the edit or resolve the conflict, then pull again.`
        );
      }
    },

    /**
     * A download replaces the local file at `absolutePath`, if there is one.
     * That is safe when the local file already holds what Drive has, or has not
     * changed since the last sync. Replacing a file the user chose to overwrite
     * (`overwriteLocal`: `pull --all --force`, `pull --force`, `resolve --theirs`) is allowed,
     * but only as it was when they chose: an edit made since is not covered by
     * that choice. `remoteMd5` is the content about to be written.
     */
    async assertDownloadReplaceable(entry, absolutePath, remoteMd5) {
      let stat;
      try {
        stat = await fs.promises.lstat(absolutePath);
      } catch (err) {
        if (isMissingLocalFileError(err)) return; // nothing to lose
        throw err;
      }
      if (stat.isDirectory()) return; // not a file; the replacement fails on its own

      const displayPath = entry.localPath || entry.path;
      const refuse = (reason) => localWorkAtRisk(
        `Refusing to overwrite ${displayPath}: ${reason} ` +
        `Push it to keep your version, or run 'aethel pull --force' ` +
        `(with --all for a full pull) to take the Drive version.`
      );

      if (entry.overwriteLocal) {
        if (!entry.localMd5) return; // no state was recorded when the choice was made
        const current = await hashOrNull(absolutePath);
        if (current === null || current === entry.localMd5 || current === remoteMd5) return;
        throw refuse("it was edited after you chose to replace it with the Drive version.");
      }

      // The baseline's record of this file: by Drive ID, else by the path a
      // replacement file now has (Drive gives a re-uploaded file a new ID).
      const bound = snapshot?.files?.[entry.fileId] ?? synced().get(entry.path) ?? null;
      const baselinePath = bound && (bound.localPath || bound.path);
      const baseline = baselinePath ? snapshot.localFiles?.[baselinePath] ?? null : null;
      if (baseline && matchesBaselineStat(stat, baseline)) return;

      const current = await hashOrNull(absolutePath);
      if (current === null) return;
      if (remoteMd5 && current === remoteMd5) return; // already what Drive has
      if (baseline && current === baseline.md5) return; // unchanged since the last sync

      throw refuse(
        baseline
          ? "it changed locally since the last sync."
          : "a different local file is already there that Drive has not synced."
      );
    },
  };
}

async function moveLocalFolder(entry, root) {
  const sourcePath = entry.sourcePath;
  if (!sourcePath) throw new Error("Missing source path for local folder move");
  const source = toLocalAbsolutePath(root, sourcePath);
  const destination = toLocalAbsolutePath(root, entry.localPath || entry.path);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await renameWithRetry(source, destination);
}

// Windows can transiently refuse directory renames (EPERM/EBUSY/EACCES) while
// another process or a just-closed handle still references the tree.
async function renameWithRetry(source, destination, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.promises.rename(source, destination);
    } catch (err) {
      const transient = ["EPERM", "EBUSY", "EACCES"].includes(err.code);
      if (!transient || attempt >= attempts || process.platform !== "win32") throw err;
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
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

  const destinationPath = entry.remotePath || entry.path;
  const update = {
    fileId,
    requestBody: { name: path.posix.basename(destinationPath) },
    fields: "id,name",
  };

  // A folder moved under a different parent changes its parent as well as its
  // name; updating the name alone would leave it where it was.
  const movesParent =
    entry.sourcePath && parentPathOf(entry.sourcePath) !== parentPathOf(destinationPath);
  if (movesParent) {
    const destinationParentId = await ensureFolder(
      drive,
      parentPathOf(destinationPath),
      driveFolderId
    );
    const current = await drive.files.get({
      fileId,
      fields: "id,parents",
      supportsAllDrives: true,
    });
    const oldParentIds = (current.data?.parents || []).filter((id) => id !== destinationParentId);
    if (oldParentIds.length > 0 || !(current.data?.parents || []).includes(destinationParentId)) {
      update.addParents = destinationParentId;
      if (oldParentIds.length > 0) update.removeParents = oldParentIds.join(",");
      update.supportsAllDrives = true;
      update.fields = "id,name,parents";
    }
  }

  await drive.files.update(update);
  // The memoized folder IDs are keyed by parent and name, so the old location
  // would keep resolving to the folder that has just left it.
  if (movesParent) resetFolderLookupCache();
}

function parentPathOf(pathValue) {
  const parent = path.posix.dirname(String(pathValue || ""));
  return parent === "." ? "" : parent;
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

/**
 * Remove directories left empty above `relativePath`, walking up to the
 * workspace root. `retainDirectory` is the deepest ancestor that still exists
 * on Drive: Drive keeps empty folders, so that directory and everything above
 * it stay. Without it every empty ancestor goes (older staged entries).
 */
async function cleanupEmptyParentDirectories(root, relativePath, retainDirectory) {
  let currentPath = path.dirname(toLocalAbsolutePath(root, relativePath));
  const resolvedRoot = path.resolve(root);
  const retainedPath = retainDirectory
    ? toLocalAbsolutePath(root, retainDirectory)
    : null;

  while (currentPath !== resolvedRoot) {
    if (currentPath === retainedPath) break;
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
  let done = 0;
  let fatal = null;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (!fatal && next < tasks.length) {
      const index = next++;
      let error = null;
      let result = null;
      try { result = await tasks[index](); } catch (err) { error = err; }
      try { onDone?.(++done, tasks.length, index, error, result); }
      catch (err) { fatal = err; }
    }
  });
  // Wait for already-running transfers before releasing the workspace lock.
  await Promise.all(workers);
  if (fatal) throw fatal;
}

// ── Main executor ────────────────────────────────────────────────────

export async function executeStaged(drive, root, progress) {
  return withRunLog(root, "execute-staged", () =>
    withWorkspaceLock(root, () => executeStagedOperations(drive, root, progress)));
}

async function executeStagedOperations(drive, root, progress) {
  const config = readConfig(root);
  const index = readIndex(root);
  const journal = openExecutionJournal(root);
  journal.assertRecoverable();
  const previouslyCompleted = new Set(journal.completed().map(op => operationKey(op.original)));
  const staged = (index.staged || []).filter(entry => !previouslyCompleted.has(operationKey(entry)));
  logEvent("info", "sync.started", { operations: staged.length });
  const operationIds = new Map(staged.map(entry => [entry, journal.newId()]));
  const originals = new Map(staged.map(entry => [entry, structuredClone(entry)]));
  const logOperation = (level, event, entry, error) => {
    if (error?.code === "JOURNAL_IO") throw error;
    const state = event.split(".").at(-1);
    journal.record(operationIds.get(entry), state, originals.get(entry), entry);
    logEvent(level, event, {
      operationId: operationIds.get(entry), action: entry.action, path: entry.path,
      sourcePath: entry.sourcePath, fileId: entry.fileId, error,
    });
  };
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
  const failedEntries = new Set();
  const failedMoves = [];
  function assertDependencies(entry) {
    const paths = [entry.path, entry.sourcePath, entry.localPath, entry.remotePath].filter(Boolean);
    const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    if (failedMoves.some(move => paths.some(candidate =>
      [move.path, move.sourcePath].filter(Boolean).some(parent => overlaps(candidate, parent))))) {
      throw Object.assign(new Error("Dependency failed: a required folder move did not complete."), { code: "DEPENDENCY_FAILED" });
    }
  }

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
    logOperation("info", "operation.started", entry);
    try {
      assertDependencies(entry);
      await renameRemoteFolder(drive, entry, driveFolderId);
      result.foldersRenamed++;
      logOperation("info", "operation.completed", entry);
    } catch (err) {
      logOperation("error", "operation.failed", entry, err);
      failedEntries.add(entry);
      failedMoves.push(entry);
      result.errors.push(`rename_remote ${entry.path}: ${err.message}`);
    }
  }

  // A successful remote rename moved every remote descendant with it — remap
  // pending remote targets so uploads land in the renamed folder instead of
  // recreating the old one.
  for (const { entry: rename } of remoteRenames) {
    if (failedEntries.has(rename) || !rename.sourcePath) continue;
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
    logOperation("info", "operation.started", entry);
    try {
      assertDependencies(entry);
      await moveLocalFolder(
        {
          ...entry,
          localPath: localMoveDestinationBeforeAncestorMoves(entry, localMoves),
        },
        root
      );
      logOperation("info", "operation.completed", entry);
    } catch (err) {
      logOperation("error", "operation.failed", entry, err);
      failedEntries.add(entry);
      failedMoves.push(entry);
      result.errors.push(`move_local ${entry.path}: ${err.message}`);
    }
  }

  // A successful move relocated every local descendant with it — remap
  // pending local paths so later uploads and deletes find their files at the
  // moved location instead of treating them as missing (which would trash
  // the remote copy). Applied in executed (deepest-source-first) order so
  // nested moves compose to each entry's final path.
  for (const { entry: move } of localMoves) {
    if (failedEntries.has(move) || !move.sourcePath) continue;
    const moveDestination = move.localPath || move.path;
    for (const { entry } of [...remoteOps, ...localDeletes]) {
      const remapped = remapPathAfterRename(
        entry.localPath || entry.path,
        move.sourcePath,
        moveDestination
      );
      if (remapped !== (entry.localPath || entry.path)) {
        entry.localPath = remapped;
        // The retained ancestor lives in the same path space as the entry.
        if (entry.retainDirectory) {
          entry.retainDirectory = remapPathAfterRename(
            entry.retainDirectory,
            move.sourcePath,
            moveDestination
          );
        }
      }
    }
  }

  // The old parents of a moved folder are now empty. Drop the ones Drive no
  // longer has, after every move, so a pending move never loses its parent.
  // Otherwise they linger and the next scan reads them as new local folders.
  for (const { entry: move } of localMoves) {
    if (failedEntries.has(move) || !move.sourcePath) continue;
    if (typeof move.retainDirectory !== "string") continue;
    await cleanupEmptyParentDirectories(root, move.sourcePath, move.retainDirectory);
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

  const localWorkGuard = createLocalWorkGuard(root, snapshot);
  const localDeleteResults = await Promise.allSettled(
    localFileDeletes.map(async ({ entry }) => {
      logOperation("info", "operation.started", entry);
      try {
        assertDependencies(entry);
        await deleteLocalFile(entry, root, localWorkGuard);
        result.deletedLocal++;
        logOperation("info", "operation.completed", entry);
      } catch (err) {
        logOperation("error", "operation.failed", entry, err);
        failedEntries.add(entry);
        result.errors.push(`delete_local ${entry.path}: ${err.message}`);
      }
    })
  );

  const fatalDelete = localDeleteResults.find(result => result.status === "rejected");
  if (fatalDelete) throw fatalDelete.reason;

  const successfulLocalFileDeletes = localFileDeletes
    .filter(({ entry }) => !failedEntries.has(entry))
    .sort((left, right) => right.entry.path.split("/").length - left.entry.path.split("/").length);
  for (const { entry } of successfulLocalFileDeletes) {
    await cleanupEmptyParentDirectories(
      root,
      entry.localPath || entry.path,
      entry.retainDirectory
    );
  }

  for (const { entry } of localFolderDeletes) {
    logOperation("info", "operation.started", entry);
    try {
      assertDependencies(entry);
      if (entry.recursiveLocalDelete) await localWorkGuard.assertFolderDeletable(entry);
      await deleteLocalFile(entry, root, localWorkGuard);
      result.deletedLocal++;
      logOperation("info", "operation.completed", entry);
    } catch (err) {
      logOperation("error", "operation.failed", entry, err);
      failedEntries.add(entry);
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
      logOperation("info", "operation.started", entry);
      assertDependencies(entry);
      const action = entry.action;
      if (action === "download") {
        await downloadStagedFile(drive, entry, root, snapshot, localWorkGuard);
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
      logOperation("error", "operation.failed", op.entry, err);
      failedEntries.add(op.entry);
      result.errors.push(`${op.entry.action} ${op.entry.path}: ${err.message}`);
    } else {
      logOperation("info", "operation.completed", op.entry);
    }
    progress?.(completed - 1, staged.length, op.entry.action, path.posix.basename(op.entry.path || ""));
  });

  progress?.(staged.length, staged.length, "done", "");

  // Only clear succeeded entries — keep failed ones staged for retry
  if (failedEntries.size > 0) {
    index.staged = staged.filter((e) => failedEntries.has(e));
  } else {
    index.staged = [];
  }
  writeIndex(root, index);
  logEvent(result.errors.length ? "warn" : "info", "sync.finished", {
    summary: result.summary, failures: result.errors.length, remainingStaged: index.staged.length,
  });

  return result;
}
