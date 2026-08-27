/**
 * Repository — unified data-access layer for Aethel workspaces.
 *
 * Wraps all core modules behind a single interface so that both
 * the CLI and the TUI share the same entry point for state loading,
 * staging, syncing, file browsing, and history.
 */

import fs from "node:fs";
import path from "node:path";
import { authenticate } from "./auth.js";
import {
  AETHEL_DIR,
  HISTORY_DIR,
  LATEST_SNAPSHOT,
  SNAPSHOTS_DIR,
  readConfig,
  readLatestSnapshot,
  writeConfig,
  writeSnapshot,
} from "./config.js";
import { computeDiff } from "./diff.js";
import {
  assertNoDuplicateFolders,
  batchOperateFiles,
  getAccountInfo,
  getRemoteState,
  listIgnoredRemoteItems,
  listAccessibleFiles,
  listRootFolders,
  syncLocalDirectoryToParent,
  uploadLocalEntry,
  withDriveRetry,
} from "./drive-api.js";
import {
  invalidateRemoteCache,
  readRemoteCache,
  writeRemoteCache,
} from "./remote-cache.js";
import {
  buildSnapshot,
  hashFile,
  md5Local,
  scanLocal,
  verifySnapshotChecksum,
} from "./snapshot.js";
import {
  stageChange,
  stageChanges,
  stageConflictResolution,
  stageFullRemotePull,
  stageRemoteFilesForDownload,
  stagedEntries,
  unstageAll,
  unstagePath,
} from "./staging.js";
import { executeStaged } from "./sync.js";
import {
  deleteLocalEntry,
  listLocalEntries,
  renameLocalEntry,
} from "./local-fs.js";

function isPathOrDescendant(pathValue, parentPath) {
  return pathValue === parentPath || pathValue.startsWith(`${parentPath}/`);
}

function isTrackedBySnapshot(pathValue, snapshotFiles) {
  return Object.values(snapshotFiles || {}).some((entry) => {
    const snapshotPath = entry.path || entry.localPath;
    return snapshotPath && isPathOrDescendant(snapshotPath, pathValue);
  });
}

function removePathAndDescendants(files, pathValue) {
  for (const candidate of Object.keys(files)) {
    if (isPathOrDescendant(candidate, pathValue)) {
      delete files[candidate];
    }
  }
}

function addPulledRemotePaths(files, scannedLocalFiles, remoteFiles, pathValue) {
  for (const remoteFile of remoteFiles) {
    if (!remoteFile.path || !isPathOrDescendant(remoteFile.path, pathValue)) {
      continue;
    }
    const localEntry = scannedLocalFiles[remoteFile.path];
    if (localEntry) {
      files[remoteFile.path] = localEntry;
    }
  }
}

/**
 * Build the local half of a pull snapshot without accepting unrelated local
 * edits as synced. A pull may change only selected remote paths; local-only
 * additions and local modifications must retain their pre-pull baseline so a
 * later push still detects them.
 */
function buildPulledLocalSnapshot(previousSnapshot, scannedLocal, remoteFiles, pullChanges) {
  const scannedLocalFiles = scannedLocal?.files ?? scannedLocal ?? {};
  const files = {};

  // A previous buggy pull could already have captured local-only paths. Keep
  // only entries that were backed by a Drive item in the prior snapshot.
  for (const [pathValue, entry] of Object.entries(previousSnapshot?.localFiles || {})) {
    if (isTrackedBySnapshot(pathValue, previousSnapshot?.files)) {
      files[pathValue] = entry;
    }
  }

  for (const change of pullChanges || []) {
    const action = change.suggestedAction || change.action;
    const pathValue = change.remoteMeta?.path || change.path;
    if (!pathValue) continue;

    if (action === "delete_local") {
      removePathAndDescendants(files, pathValue);
      continue;
    }

    if (action === "move_local") {
      // Carry the previous baseline across the move by remapping its keys.
      // Adopting the post-move scan instead would record a locally-edited
      // file's current hash as "synced" and silently swallow its pending
      // upload on the next push.
      if (change.sourcePath) {
        const movedEntries = {};
        for (const [candidate, entry] of Object.entries(files)) {
          if (!isPathOrDescendant(candidate, change.sourcePath)) continue;
          const movedPath = `${pathValue}${candidate.slice(change.sourcePath.length)}`;
          movedEntries[movedPath] = entry.localPath
            ? { ...entry, localPath: movedPath }
            : entry;
          delete files[candidate];
        }
        Object.assign(files, movedEntries);
      }
      // Fill only the gaps (paths with no carried baseline) from the scan.
      for (const remoteFile of remoteFiles) {
        if (!remoteFile.path || !isPathOrDescendant(remoteFile.path, pathValue)) {
          continue;
        }
        if (files[remoteFile.path]) continue;
        const localEntry = scannedLocalFiles[remoteFile.path];
        if (localEntry) {
          files[remoteFile.path] = localEntry;
        }
      }
      continue;
    }

    if (action === "download") {
      addPulledRemotePaths(files, scannedLocalFiles, remoteFiles, pathValue);
    }
  }

  return files;
}

export class Repository {
  /**
   * @param {string|null} root  Workspace root (null for workspace-less commands like auth/clean)
   * @param {object} [options]
   * @param {object} [options.drive]       Pre-authenticated drive instance (skips auth)
   * @param {string} [options.credentials] Path to OAuth credentials JSON
   * @param {string} [options.token]       Path to OAuth token JSON
   * @param {boolean} [options.forceAuth]  Force browser OAuth instead of cached token
   */
  constructor(root, options = {}) {
    this._root = root;
    this._options = options;
    this._drive = options.drive || null;
    this._config = null;
  }

  get root() {
    return this._root;
  }

  get isConnected() {
    return this._drive !== null;
  }

  get drive() {
    if (!this._drive) {
      throw new Error("Repository is not connected. Call connect() first.");
    }
    return this._drive;
  }

  /** Authenticate and prepare the drive connection. Idempotent. */
  async connect() {
    if (this._drive) return;
    const raw = await authenticate(this._options.credentials, this._options.token, {
      force: Boolean(this._options.forceAuth),
    });
    this._drive = withDriveRetry(raw);
  }

  /**
   * Connect on demand and return the drive client. Lets read-only commands
   * skip authentication entirely when a cached remote listing already answers
   * the question.
   */
  async connectedDrive() {
    await this.connect();
    return this._drive;
  }

  // ── Config ──────────────────────────────────────────────────────────

  getConfig() {
    if (!this._config) {
      this._config = readConfig(this._root);
    }
    return this._config;
  }

  setConfig(data) {
    writeConfig(this._root, data);
    this._config = null;
  }

  // ── State loading (sync workflow) ───────────────────────────────────

  /**
   * Load full workspace state in parallel, replacing the old
   * loadWorkspaceState() helper from cli.js.
   */
  async loadState({ useCache = true, remoteCacheTtlMs, onPhase } = {}) {
    const config = this.getConfig();
    const t0 = Date.now();

    // The remote fetch is the slowest leg — overlap it with the local scan.
    const timings = {};

    // Start the local walk first so its filesystem I/O overlaps the
    // (synchronous) snapshot read below.
    const localPromise = scanLocal(this._root).then((r) => {
      timings.localMs = Date.now() - t0;
      onPhase?.("local", timings.localMs);
      return r;
    });

    const snapshot = readLatestSnapshot(this._root);
    timings.snapshotMs = Date.now() - t0;

    // Pass the snapshot down: the remote loader sizes its fetch strategy from
    // it, and re-reading it there costs a second full parse of a file that can
    // run to tens of megabytes.
    const remotePromise = this._loadRemoteState({
      useCache,
      cacheTtlMs: remoteCacheTtlMs,
      snapshot,
    }).then((r) => {
      timings.remoteMs = Date.now() - t0;
      timings.remoteCached = Boolean(r.cacheTimestamp);
      timings.remoteCacheAgeMs = r.cacheAgeMs ?? null;
      onPhase?.("remote", timings.remoteMs);
      return r;
    });

    const [local, remoteState] = await Promise.all([localPromise, remotePromise]);
    const remote = remoteState.files;

    const diffStart = Date.now();
    const diff = computeDiff(snapshot, remote, local, { root: this._root });
    timings.diffMs = Date.now() - diffStart;
    timings.totalMs = Date.now() - t0;
    timings.localFiles = Object.keys(local).length;
    timings.remoteFiles = remote.length;

    return {
      config,
      remote,
      remoteState,
      local,
      snapshot,
      diff,
      timings,
    };
  }

  async getRemoteState({ useCache = true, snapshot } = {}) {
    return this._loadRemoteState({ useCache, snapshot });
  }

  async scanLocal() {
    return scanLocal(this._root);
  }

  getSnapshot() {
    return readLatestSnapshot(this._root);
  }

  computeDiff(snapshot, remote, local) {
    return computeDiff(snapshot, remote, local, { root: this._root });
  }

  // ── Staging ─────────────────────────────────────────────────────────

  getStagedEntries() {
    return stagedEntries(this._root);
  }

  stageChange(change) {
    return stageChange(this._root, change);
  }

  stageChanges(changes) {
    return stageChanges(this._root, changes);
  }

  stageRemoteFilesForDownload(remoteFiles) {
    return stageRemoteFilesForDownload(this._root, remoteFiles);
  }

  stageFullRemotePull(remoteFiles, remoteDeletions, remoteRenames) {
    return stageFullRemotePull(this._root, remoteFiles, remoteDeletions, remoteRenames);
  }

  unstagePath(targetPath) {
    return unstagePath(this._root, targetPath);
  }

  unstageAll() {
    return unstageAll(this._root);
  }

  stageConflictResolution(change, strategy) {
    return stageConflictResolution(this._root, change, strategy);
  }

  // ── Sync execution ──────────────────────────────────────────────────

  async executeStaged(progress) {
    return executeStaged(this.drive, this._root, progress);
  }

  async commitStaged({ message = "sync", snapshotHint, progress } = {}) {
    const result = await this.executeStaged(progress);
    if (result.errors.length > 0) {
      return result;
    }

    await this.saveSnapshot(message, snapshotHint);
    return result;
  }

  /**
   * Build and persist a new snapshot.
   *
   * @param {string} message
   * @param {object} [preloaded]
   * @param {object} [preloaded.remote]  Reuse this remote state (skip API call)
   * @param {object} [preloaded.local]   Reuse this local scan  (skip fs walk)
   */
  async saveSnapshot(message = "sync", { remote, local, pullChanges } = {}) {
    const config = this.getConfig();
    const rootFolderId = config.drive_folder_id || null;

    // Only fetch what wasn't pre-loaded, in parallel.
    const needRemote = !remote;
    const needLocal = !local;

    if (needRemote) invalidateRemoteCache(this._root);

    const remoteFetchOptions = needRemote
      ? { ...this._remoteFetchOptions(), refreshRemoteMemo: true }
      : null;
    const [remoteState, localFiles] = await Promise.all([
      needRemote ? getRemoteState(this.drive, rootFolderId, null, remoteFetchOptions) : remote,
      needLocal ? scanLocal(this._root) : local,
    ]);

    assertNoDuplicateFolders(remoteState.duplicateFolders);
    writeRemoteCache(this._root, remoteState, rootFolderId);
    const snapshotLocalFiles = pullChanges
      ? {
          files: buildPulledLocalSnapshot(
            readLatestSnapshot(this._root),
            localFiles,
            remoteState.files,
            pullChanges
          ),
          packedDirs: localFiles?.packedDirs ?? {},
        }
      : localFiles;
    const snapshot = buildSnapshot(remoteState.files, snapshotLocalFiles, message);
    writeSnapshot(this._root, snapshot);
    this.updateCurrentBranch(snapshot);
  }

  // ── Cache management ────────────────────────────────────────────────

  invalidateRemoteCache() {
    invalidateRemoteCache(this._root);
  }

  // ── File browser (TUI) ─────────────────────────────────────────────

  async listRootFolders() {
    return listRootFolders(this.drive);
  }

  async listRemoteFiles({ includeSharedDrives = false } = {}) {
    return listAccessibleFiles(this.drive, includeSharedDrives);
  }

  async listIgnoredRemoteItems(ignoreRules, { includeSharedDrives = false } = {}) {
    const config = this.getConfig();
    const rootFolderId = config.drive_folder_id || null;
    return listIgnoredRemoteItems(this.drive, rootFolderId, ignoreRules, {
      includeSharedDrives,
    });
  }

  async listLocalEntries(targetPath) {
    return listLocalEntries(targetPath);
  }

  async deleteLocalEntry(targetPath) {
    return deleteLocalEntry(targetPath);
  }

  async renameLocalEntry(targetPath, newName) {
    return renameLocalEntry(targetPath, newName);
  }

  async uploadLocalEntry(localPath, parentId, onProgress) {
    return uploadLocalEntry(this.drive, localPath, parentId, onProgress);
  }

  async syncLocalDirectory(localPath, parentId, onProgress) {
    return syncLocalDirectoryToParent(this.drive, localPath, parentId, onProgress);
  }

  async batchOperateFiles(files, options) {
    return batchOperateFiles(this.drive, files, options);
  }

  async getAccountInfo() {
    return getAccountInfo(this.drive);
  }

  // ── History ─────────────────────────────────────────────────────────

  snapshotRef(snapshot) {
    return String(snapshot?.timestamp || "snapshot").replace(/[-:TZ.]/g, "").slice(0, 12);
  }

  _validateRefName(name, kind) {
    if (!/^[A-Za-z0-9._/-]+$/.test(name || "")) {
      throw new Error(`${kind} names may contain letters, numbers, '.', '_', '-', and '/'.`);
    }
  }

  _tagsPath() {
    return path.join(this._root, AETHEL_DIR, "refs", "tags.json");
  }

  _branchesPath() {
    return path.join(this._root, AETHEL_DIR, "refs", "branches.json");
  }

  _readTagsFile() {
    const p = this._tagsPath();
    if (!fs.existsSync(p)) {
      return { tags: {} };
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  _writeTagsFile(data) {
    const p = this._tagsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  }

  _readBranchesFile() {
    const p = this._branchesPath();
    if (!fs.existsSync(p)) {
      const latest = readLatestSnapshot(this._root);
      return {
        current: "main",
        branches: {
          main: latest
            ? this._branchEntry(latest)
            : { ref: null, timestamp: null, message: "", updatedAt: null },
        },
      };
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  _writeBranchesFile(data) {
    const p = this._branchesPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    data.current ||= "main";
    data.branches ||= {};
    data.branches.main ||= { ref: null, timestamp: null, message: "", updatedAt: null };
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  }

  _branchEntry(snapshot) {
    return {
      ref: this.snapshotRef(snapshot),
      timestamp: snapshot?.timestamp || null,
      message: snapshot?.message || "",
      updatedAt: new Date().toISOString(),
    };
  }

  getHistory(limit = 10) {
    const snapshotsPath = path.join(this._root, AETHEL_DIR, SNAPSHOTS_DIR);
    const entries = [];

    const latestPath = path.join(snapshotsPath, LATEST_SNAPSHOT);
    if (fs.existsSync(latestPath)) {
      entries.push(JSON.parse(fs.readFileSync(latestPath, "utf8")));
    }

    const historyPath = path.join(snapshotsPath, HISTORY_DIR);
    if (fs.existsSync(historyPath)) {
      const historyFiles = fs
        .readdirSync(historyPath)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();

      for (const fileName of historyFiles) {
        entries.push(
          JSON.parse(fs.readFileSync(path.join(historyPath, fileName), "utf8"))
        );
      }
    }

    return entries.slice(0, limit);
  }

  getTags() {
    return this._readTagsFile().tags || {};
  }

  getBranches() {
    const data = this._readBranchesFile();
    return {
      current: data.current || "main",
      branches: data.branches || {},
    };
  }

  createBranch(name, ref = "HEAD", { force = false } = {}) {
    this._validateRefName(name, "Branch");
    const data = this._readBranchesFile();
    data.branches ||= {};

    if (data.branches[name] && !force) {
      throw new Error(`Branch '${name}' already exists. Use --force to replace it.`);
    }

    const snapshot = this.getSnapshotByRef(ref);
    if (!snapshot) {
      throw new Error(`No snapshot matching '${ref}' found.`);
    }

    const entry = this._branchEntry(snapshot);
    data.branches[name] = entry;
    this._writeBranchesFile(data);
    return entry;
  }

  switchBranch(name, { create = false, ref = "HEAD" } = {}) {
    this._validateRefName(name, "Branch");
    const data = this._readBranchesFile();
    data.branches ||= {};

    if (!data.branches[name]) {
      if (!create) {
        throw new Error(`Unknown branch '${name}'. Use 'aethel switch -c ${name}' to create it.`);
      }
      const snapshot = this.getSnapshotByRef(ref);
      if (!snapshot) {
        throw new Error(`No snapshot matching '${ref}' found.`);
      }
      data.branches[name] = this._branchEntry(snapshot);
    }

    data.current = name;
    this._writeBranchesFile(data);
    return data.branches[name];
  }

  deleteBranch(name) {
    const data = this._readBranchesFile();
    if ((data.current || "main") === name) {
      throw new Error(`Cannot delete the current branch '${name}'.`);
    }
    if (!data.branches?.[name]) {
      return false;
    }
    delete data.branches[name];
    this._writeBranchesFile(data);
    return true;
  }

  updateCurrentBranch(snapshot) {
    const data = this._readBranchesFile();
    const current = data.current || "main";
    data.branches ||= {};
    data.branches[current] = this._branchEntry(snapshot);
    this._writeBranchesFile(data);
  }

  createTag(name, ref = "HEAD", { force = false } = {}) {
    this._validateRefName(name, "Tag");

    const data = this._readTagsFile();
    data.tags ||= {};

    if (data.tags[name] && !force) {
      throw new Error(`Tag '${name}' already exists. Use --force to replace it.`);
    }

    const snapshot = this.getSnapshotByRef(ref);
    if (!snapshot) {
      throw new Error(`No snapshot matching '${ref}' found.`);
    }

    const tag = {
      ref: this.snapshotRef(snapshot),
      timestamp: snapshot.timestamp || null,
      message: snapshot.message || "",
      createdAt: new Date().toISOString(),
    };

    data.tags[name] = tag;
    this._writeTagsFile(data);
    return tag;
  }

  deleteTag(name) {
    const data = this._readTagsFile();
    if (!data.tags?.[name]) {
      return false;
    }
    delete data.tags[name];
    this._writeTagsFile(data);
    return true;
  }

  getSnapshotByRef(ref) {
    if (!ref || ref === "HEAD" || ref === "latest") {
      return readLatestSnapshot(this._root);
    }

    const tag = this.getTags()[ref];
    if (tag?.ref && tag.ref !== ref) {
      return this.getSnapshotByRef(tag.ref);
    }

    const branch = this.getBranches().branches?.[ref];
    if (branch?.ref && branch.ref !== ref) {
      return this.getSnapshotByRef(branch.ref);
    }

    const matchesRef = (snapshot) => {
      const normalized = this.snapshotRef(snapshot);
      return normalized.startsWith(ref) || String(snapshot?.timestamp || "").startsWith(ref);
    };

    const latest = readLatestSnapshot(this._root);
    if (latest && matchesRef(latest)) {
      return latest;
    }

    const historyPath = path.join(
      this._root,
      AETHEL_DIR,
      SNAPSHOTS_DIR,
      HISTORY_DIR
    );

    if (!fs.existsSync(historyPath)) return null;

    const files = fs
      .readdirSync(historyPath)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    for (const file of files) {
      const snapshot = JSON.parse(fs.readFileSync(path.join(historyPath, file), "utf-8"));
      if (file.startsWith(ref) || matchesRef(snapshot)) {
        return snapshot;
      }
    }

    return null;
  }

  // ── Integrity verification ──────────────────────────────────────────

  /**
   * Full integrity verification of the workspace.
   * Checks: snapshot checksum, local files vs snapshot md5, remote vs snapshot md5.
   *
   * @param {object} [options]
   * @param {boolean} [options.checkRemote=false]  Also verify remote checksums (requires connect)
   * @param {function} [options.onProgress]         (done, total, path, status) callback
   * @returns {{ ok: boolean, snapshot: object, local: object[], remote: object[] }}
   */
  async verify({ checkRemote = false, onProgress } = {}) {
    const snapshot = readLatestSnapshot(this._root, { verify: true });
    const result = { ok: true, snapshot: { valid: true }, local: [], remote: [] };

    if (!snapshot) {
      return { ok: true, snapshot: { valid: true, reason: "no snapshot yet" }, local: [], remote: [] };
    }

    // 1. Snapshot integrity
    const snapshotCheck = verifySnapshotChecksum(snapshot);
    result.snapshot = snapshotCheck;
    if (!snapshotCheck.valid) result.ok = false;

    // 2. Local file integrity vs snapshot
    const localFiles = snapshot.localFiles || {};
    const entries = Object.entries(localFiles).filter(([, meta]) => !meta.isFolder);
    const total = entries.length + (checkRemote ? Object.keys(snapshot.files || {}).length : 0);
    let done = 0;

    for (const [relativePath, meta] of entries) {
      const absPath = path.join(this._root, ...relativePath.split("/"));
      const entry = { path: relativePath, status: "ok" };

      if (!fs.existsSync(absPath)) {
        entry.status = "missing";
        result.ok = false;
      } else if (meta.md5) {
        const actual = await md5Local(absPath);
        if (actual !== meta.md5) {
          entry.status = "modified";
          entry.expected = meta.md5;
          entry.actual = actual;
          result.ok = false;
        }
      }

      if (entry.status !== "ok") result.local.push(entry);
      done++;
      onProgress?.(done, total, relativePath, entry.status);
    }

    // 3. Remote integrity vs snapshot (optional, requires API call)
    if (checkRemote) {
      const remoteState = await this._loadRemoteState({ useCache: false });
      const remoteById = new Map(remoteState.files.map((f) => [f.id, f]));

      for (const [fileId, snapEntry] of Object.entries(snapshot.files || {})) {
        if (snapEntry.isFolder) { done++; continue; }
        const entry = { path: snapEntry.path || snapEntry.localPath, status: "ok" };
        const remote = remoteById.get(fileId);

        if (!remote) {
          entry.status = "deleted_remote";
          result.ok = false;
        } else if (snapEntry.md5Checksum && remote.md5Checksum && snapEntry.md5Checksum !== remote.md5Checksum) {
          entry.status = "modified_remote";
          entry.expected = snapEntry.md5Checksum;
          entry.actual = remote.md5Checksum;
          result.ok = false;
        }

        if (entry.status !== "ok") result.remote.push(entry);
        done++;
        onProgress?.(done, total, entry.path, entry.status);
      }
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  async _loadRemoteState({ useCache = true, cacheTtlMs, snapshot } = {}) {
    const config = this.getConfig();
    const rootFolderId = config.drive_folder_id || null;

    let remoteState = useCache
      ? readRemoteCache(this._root, rootFolderId, cacheTtlMs)
      : null;

    if (!remoteState) {
      // Only authenticate once we know the cache cannot answer this.
      const drive = await this.connectedDrive();
      remoteState = await getRemoteState(
        drive,
        rootFolderId,
        null,
        this._remoteFetchOptions(snapshot)
      );
      writeRemoteCache(this._root, remoteState, rootFolderId);
    }

    assertNoDuplicateFolders(remoteState.duplicateFolders);
    return remoteState;
  }

  _remoteFetchOptions(snapshot) {
    const resolved = snapshot === undefined ? readLatestSnapshot(this._root) : snapshot;
    const estimatedRemoteFiles = resolved?.files
      ? Object.keys(resolved.files).length
      : null;
    return { estimatedRemoteFiles };
  }
}
