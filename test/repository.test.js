import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/core/repository.js";
import { initWorkspace, writeSnapshot } from "../src/core/config.js";
import { computeDiff, ChangeType } from "../src/core/diff.js";
import { writeRemoteCache } from "../src/core/remote-cache.js";
import { conflictResolutionChange } from "../src/core/staging.js";

function makeTmpWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-repo-test-"));
  initWorkspace(root, "fake-folder-id", "Test Drive");
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Constructor ──

test("Repository constructor stores root and is not connected", () => {
  const repo = new Repository("/tmp/fake");
  assert.equal(repo.root, "/tmp/fake");
  assert.equal(repo.isConnected, false);
});

test("Repository constructor with pre-authenticated drive skips auth", () => {
  const fakeDrive = { files: {} };
  const repo = new Repository("/tmp/fake", { drive: fakeDrive });
  assert.equal(repo.isConnected, true);
  assert.equal(repo.drive, fakeDrive);
});

test("Repository.drive throws when not connected", () => {
  const repo = new Repository("/tmp/fake");
  assert.throws(() => repo.drive, /not connected/i);
});

// ── Config ──

test("getConfig reads workspace config", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const config = repo.getConfig();
    assert.equal(config.drive_folder_id, "fake-folder-id");
    assert.equal(config.drive_folder_name, "Test Drive");
  } finally {
    cleanup(root);
  }
});

test("getConfig caches after first read", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const config1 = repo.getConfig();
    const config2 = repo.getConfig();
    assert.equal(config1, config2); // same reference
  } finally {
    cleanup(root);
  }
});

test("setConfig invalidates cache", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const config1 = repo.getConfig();
    repo.setConfig({ ...config1, drive_folder_name: "Updated" });
    const config2 = repo.getConfig();
    assert.notEqual(config1, config2);
    assert.equal(config2.drive_folder_name, "Updated");
  } finally {
    cleanup(root);
  }
});

// ── Staging ──

test("getStagedEntries returns empty array initially", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const staged = repo.getStagedEntries();
    assert.deepEqual(staged, []);
  } finally {
    cleanup(root);
  }
});

test("stageChange and getStagedEntries round-trip", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChange({
      path: "test.txt",
      suggestedAction: "download",
      fileId: "abc123",
      remoteMeta: { path: "test.txt" },
    });
    const staged = repo.getStagedEntries();
    assert.equal(staged.length, 1);
    assert.equal(staged[0].path, "test.txt");
    assert.equal(staged[0].action, "download");
  } finally {
    cleanup(root);
  }
});

test("stageChanges stages multiple and returns count", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const count = repo.stageChanges([
      { path: "a.txt", suggestedAction: "download", fileId: "1" },
      { path: "b.txt", suggestedAction: "upload" },
    ]);
    assert.equal(count, 2);
    assert.equal(repo.getStagedEntries().length, 2);
  } finally {
    cleanup(root);
  }
});

test("stageChange preserves remote-deleted folder metadata", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChange({
      path: "removed-folder",
      suggestedAction: "delete_local",
      fileId: "folder-id",
      snapshotMeta: {
        path: "removed-folder",
        isFolder: true,
      },
    });

    assert.deepEqual(repo.getStagedEntries(), [
      {
        action: "delete_local",
        path: "removed-folder",
        localPath: "removed-folder",
        fileId: "folder-id",
        isFolder: true,
        recursiveLocalDelete: true,
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("stageChange preserves transfer metadata for upload and download", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChange({
      path: "upload.txt",
      suggestedAction: "upload",
      localMeta: {
        localPath: "upload.txt",
        md5: "local-md5",
        size: 42,
        modifiedTime: "2026-06-20T01:02:03.000Z",
      },
    });
    repo.stageChange({
      path: "download.txt",
      suggestedAction: "download",
      fileId: "remote-id",
      remoteMeta: {
        path: "download.txt",
        mimeType: "text/plain",
        md5Checksum: "remote-md5",
      },
    });

    assert.deepEqual(repo.getStagedEntries(), [
      {
        action: "upload",
        path: "upload.txt",
        localPath: "upload.txt",
        localMd5: "local-md5",
        localSize: 42,
        localModifiedTime: "2026-06-20T01:02:03.000Z",
      },
      {
        action: "download",
        path: "download.txt",
        localPath: "download.txt",
        fileId: "remote-id",
        remotePath: "download.txt",
        remoteMimeType: "text/plain",
        remoteMd5Checksum: "remote-md5",
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("stageRemoteFilesForDownload stages full remote downloads", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const count = repo.stageRemoteFilesForDownload([
      {
        id: "file-1",
        path: "docs/spec.txt",
        mimeType: "text/plain",
        md5Checksum: "remote-md5",
      },
      { id: "folder-1", path: "empty-dir", isFolder: true },
    ]);
    const staged = repo.getStagedEntries();
    assert.equal(count, 2);
    assert.deepEqual(staged, [
      {
        action: "download",
        path: "docs/spec.txt",
        localPath: "docs/spec.txt",
        fileId: "file-1",
        remotePath: "docs/spec.txt",
        remoteMimeType: "text/plain",
        remoteMd5Checksum: "remote-md5",
      },
      {
        action: "download",
        path: "empty-dir",
        localPath: "empty-dir",
        fileId: "folder-1",
        remotePath: "empty-dir",
        isFolder: true,
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("stageFullRemotePull preserves remote deletions during a full hydration", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const count = repo.stageFullRemotePull(
      [
        {
          id: "keep-id",
          path: "keep.txt",
          mimeType: "text/plain",
          md5Checksum: "keep-md5",
        },
      ],
      [
        {
          path: "removed-folder",
          suggestedAction: "delete_local",
          fileId: "removed-id",
          snapshotMeta: { path: "removed-folder", isFolder: true },
        },
      ]
    );

    assert.equal(count, 2);
    assert.deepEqual(repo.getStagedEntries(), [
      {
        action: "download",
        path: "keep.txt",
        localPath: "keep.txt",
        fileId: "keep-id",
        remotePath: "keep.txt",
        remoteMimeType: "text/plain",
        remoteMd5Checksum: "keep-md5",
      },
      {
        action: "delete_local",
        path: "removed-folder",
        localPath: "removed-folder",
        fileId: "removed-id",
        isFolder: true,
        recursiveLocalDelete: true,
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("stageFullRemotePull preserves remote folder renames during a full hydration", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    const count = repo.stageFullRemotePull(
      [
        {
          id: "renamed-folder-id",
          path: "new-folder",
          isFolder: true,
        },
        {
          id: "child-id",
          path: "new-folder/notes.txt",
          mimeType: "text/plain",
          md5Checksum: "notes-md5",
        },
      ],
      [],
      [
        {
          path: "new-folder",
          sourcePath: "old-folder",
          suggestedAction: "move_local",
          fileId: "renamed-folder-id",
          remoteMeta: { path: "new-folder", isFolder: true },
          snapshotMeta: { path: "old-folder", isFolder: true },
        },
      ]
    );

    assert.equal(count, 3);
    assert.deepEqual(repo.getStagedEntries(), [
      {
        action: "move_local",
        path: "new-folder",
        localPath: "new-folder",
        fileId: "renamed-folder-id",
        sourcePath: "old-folder",
        remotePath: "new-folder",
        isFolder: true,
      },
      {
        action: "download",
        path: "new-folder/notes.txt",
        localPath: "new-folder/notes.txt",
        fileId: "child-id",
        remotePath: "new-folder/notes.txt",
        remoteMimeType: "text/plain",
        remoteMd5Checksum: "notes-md5",
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("unstagePath removes a staged entry", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChange({ path: "x.txt", suggestedAction: "download", fileId: "1" });
    assert.equal(repo.unstagePath("x.txt"), true);
    assert.equal(repo.getStagedEntries().length, 0);
  } finally {
    cleanup(root);
  }
});

test("unstagePath returns false for missing entry", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.equal(repo.unstagePath("nope.txt"), false);
  } finally {
    cleanup(root);
  }
});

test("unstageAll clears all staged entries", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageChanges([
      { path: "a.txt", suggestedAction: "download", fileId: "1" },
      { path: "b.txt", suggestedAction: "upload" },
    ]);
    const count = repo.unstageAll();
    assert.equal(count, 2);
    assert.equal(repo.getStagedEntries().length, 0);
  } finally {
    cleanup(root);
  }
});

test("stageConflictResolution ours deletes remote when local side is missing", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    repo.stageConflictResolution({
      path: "deleted-locally.md",
      fileId: "drive-file-id",
      localMeta: null,
      remoteMeta: { path: "deleted-locally.md" },
      snapshotMeta: { path: "deleted-locally.md" },
    }, "ours");

    assert.deepEqual(repo.getStagedEntries(), [
      {
        action: "delete_remote",
        path: "deleted-locally.md",
        localPath: "deleted-locally.md",
        fileId: "drive-file-id",
        remotePath: "deleted-locally.md",
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("conflictResolutionChange converts conflicts without staging side effects", () => {
  const conflict = {
    path: "notes.md",
    fileId: "drive-file-id",
    localMeta: { localPath: "notes.md", md5: "local-md5" },
    remoteMeta: { path: "notes.md", md5Checksum: "remote-md5" },
    snapshotMeta: { path: "notes.md", md5: "old-md5" },
    shortStatus: "!!",
    description: "both sides changed",
    suggestedAction: "conflict",
  };

  assert.deepEqual(
    {
      changeType: conflictResolutionChange(conflict, "ours").changeType,
      suggestedAction: conflictResolutionChange(conflict, "ours").suggestedAction,
      shortStatus: conflictResolutionChange(conflict, "ours").shortStatus,
      description: conflictResolutionChange(conflict, "ours").description,
    },
    {
      changeType: "local_modified",
      suggestedAction: "upload",
      shortStatus: "ML",
      description: "modified locally",
    }
  );

  assert.deepEqual(
    {
      changeType: conflictResolutionChange(conflict, "theirs").changeType,
      suggestedAction: conflictResolutionChange(conflict, "theirs").suggestedAction,
      shortStatus: conflictResolutionChange(conflict, "theirs").shortStatus,
      description: conflictResolutionChange(conflict, "theirs").description,
    },
    {
      changeType: "remote_modified",
      suggestedAction: "download",
      shortStatus: "MR",
      description: "modified on Drive",
    }
  );

  const localDeletion = conflictResolutionChange({ ...conflict, localMeta: null }, "ours");
  assert.equal(localDeletion.changeType, "local_deleted");
  assert.equal(localDeletion.suggestedAction, "delete_remote");
  assert.equal(localDeletion.shortStatus, "-L");
});

test("commitStaged does not save a snapshot when sync has errors", async () => {
  const root = makeTmpWorkspace();
  try {
    fs.writeFileSync(path.join(root, "upload.txt"), "upload me");
    const repo = new Repository(root, {
      drive: {
        files: {
          async create() {
            throw new Error("Drive upload failed");
          },
        },
      },
    });
    repo.stageChange({
      path: "upload.txt",
      suggestedAction: "upload",
      localMeta: { localPath: "upload.txt" },
    });

    const result = await repo.commitStaged({ message: "partial sync" });

    assert.equal(result.errors.length, 1);
    assert.equal(repo.getSnapshot(), null);
    assert.equal(repo.getStagedEntries().length, 1);
  } finally {
    cleanup(root);
  }
});

test("pull snapshots retain local-only additions and local modifications", async () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    fs.writeFileSync(path.join(root, "synced.txt"), "base");
    const baselineLocal = await repo.scanLocal();
    const baseMd5 = baselineLocal.files["synced.txt"].md5;
    writeSnapshot(root, {
      timestamp: "2026-08-16T00:00:00.000Z",
      message: "baseline",
      files: {
        synced: {
          id: "synced",
          path: "synced.txt",
          localPath: "synced.txt",
          md5Checksum: baseMd5,
        },
      },
      localFiles: baselineLocal.files,
    });

    // These local edits exist before the pull and must not become synced just
    // because another Drive file is downloaded.
    fs.writeFileSync(path.join(root, "synced.txt"), "local edit");
    fs.writeFileSync(path.join(root, "local-only.txt"), "local only");
    fs.writeFileSync(path.join(root, "remote-only.txt"), "remote only");
    const afterPullLocal = await repo.scanLocal();
    const remoteState = {
      files: [
        {
          id: "synced",
          name: "synced.txt",
          path: "synced.txt",
          mimeType: "text/plain",
          md5Checksum: baseMd5,
        },
        {
          id: "remote-only",
          name: "remote-only.txt",
          path: "remote-only.txt",
          mimeType: "text/plain",
          md5Checksum: afterPullLocal.files["remote-only.txt"].md5,
        },
      ],
      duplicateFolders: [],
    };

    await repo.saveSnapshot("pull", {
      remote: remoteState,
      pullChanges: [
        {
          suggestedAction: "download",
          path: "remote-only.txt",
          remoteMeta: remoteState.files[1],
        },
      ],
    });

    const snapshot = repo.getSnapshot();
    assert.equal(snapshot.localFiles["local-only.txt"], undefined);
    assert.equal(snapshot.localFiles["synced.txt"].md5, baseMd5);
    assert.equal(
      snapshot.localFiles["remote-only.txt"].md5,
      afterPullLocal.files["remote-only.txt"].md5
    );

    const diff = computeDiff(snapshot, remoteState.files, await repo.scanLocal());
    assert.deepEqual(
      diff.changes.map((change) => ({ type: change.changeType, path: change.path })),
      [
        { type: ChangeType.LOCAL_ADDED, path: "local-only.txt" },
        { type: ChangeType.LOCAL_MODIFIED, path: "synced.txt" },
      ]
    );
  } finally {
    cleanup(root);
  }
});

test("loadState can use an expired remote cache for fast status", async () => {
  const root = makeTmpWorkspace();
  try {
    writeRemoteCache(root, {
      files: [
        {
          id: "remote-1",
          path: "remote.txt",
          name: "remote.txt",
          mimeType: "text/plain",
          md5Checksum: "remote-md5",
        },
      ],
      duplicateFolders: [],
    }, "fake-folder-id");

    const cachePath = path.join(root, ".aethel", ".remote-cache.json");
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cache.timestamp = Date.now() - 86_400_000;
    fs.writeFileSync(cachePath, JSON.stringify(cache) + "\n");

    const repo = new Repository(root, {
      drive: {
        files: {
          async list() {
            throw new Error("status should not fetch remote state");
          },
        },
      },
    });

    const state = await repo.loadState({
      useCache: true,
      remoteCacheTtlMs: Number.POSITIVE_INFINITY,
    });

    assert.equal(state.remoteState.files.length, 1);
    assert.equal(state.timings.remoteCached, true);
    assert.ok(state.timings.remoteCacheAgeMs >= 86_000_000);
  } finally {
    cleanup(root);
  }
});

// ── History ──

test("getHistory returns empty array when no snapshots", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.deepEqual(repo.getHistory(), []);
  } finally {
    cleanup(root);
  }
});

test("getSnapshot returns null when no snapshot exists", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.equal(repo.getSnapshot(), null);
  } finally {
    cleanup(root);
  }
});

test("getSnapshotByRef returns null for missing ref", () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    assert.equal(repo.getSnapshotByRef("HEAD"), null);
    assert.equal(repo.getSnapshotByRef("2026"), null);
  } finally {
    cleanup(root);
  }
});

// ── Null root (workspace-less) ──

test("Repository with null root can be constructed", () => {
  const repo = new Repository(null);
  assert.equal(repo.root, null);
  assert.equal(repo.isConnected, false);
});

test("pull snapshots keep a local edit pending across a remote folder rename", async () => {
  const root = makeTmpWorkspace();
  try {
    const repo = new Repository(root);
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "notes.md"), "base");
    const baselineLocal = await repo.scanLocal();
    const baseMd5 = baselineLocal.files["docs/notes.md"].md5;
    writeSnapshot(root, {
      timestamp: "2026-08-16T00:00:00.000Z",
      message: "baseline",
      files: {
        child: {
          id: "child",
          path: "docs/notes.md",
          localPath: "docs/notes.md",
          md5Checksum: baseMd5,
        },
      },
      localFiles: baselineLocal.files,
    });

    // Machine 2 edits the file; machine 1 renamed docs/ -> archive/ on Drive.
    fs.writeFileSync(path.join(root, "docs", "notes.md"), "local edit");
    const remoteState = {
      files: [
        {
          id: "child",
          name: "notes.md",
          path: "archive/notes.md",
          mimeType: "text/plain",
          md5Checksum: baseMd5,
        },
      ],
      duplicateFolders: [],
    };

    // The pull's move_local has already relocated the tree by snapshot time.
    fs.renameSync(path.join(root, "docs"), path.join(root, "archive"));

    await repo.saveSnapshot("pull", {
      remote: remoteState,
      pullChanges: [
        {
          suggestedAction: "move_local",
          path: "archive",
          sourcePath: "docs",
        },
      ],
    });

    // The carried baseline must keep the PRE-edit hash — recording the edited
    // hash as synced would silently swallow the pending upload.
    const snapshot = repo.getSnapshot();
    assert.equal(snapshot.localFiles["archive/notes.md"].md5, baseMd5);
    assert.equal(snapshot.localFiles["docs/notes.md"], undefined);

    const diff = computeDiff(snapshot, remoteState.files, await repo.scanLocal());
    assert.deepEqual(
      diff.changes.map((change) => ({ type: change.changeType, path: change.path })),
      [{ type: ChangeType.LOCAL_MODIFIED, path: "archive/notes.md" }]
    );
    assert.equal(diff.changes[0].fileId, "child");
  } finally {
    cleanup(root);
  }
});
