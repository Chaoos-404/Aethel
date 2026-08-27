import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChangeType,
  computeDiff,
  changesWithLocalAuthority,
} from "../src/core/diff.js";

test("computeDiff carries snapshot Drive IDs for local changes", () => {
  const snapshot = {
    files: {
      "remote-1": {
        id: "remote-1",
        path: "docs/changed.md",
        localPath: "docs/changed.md",
        md5Checksum: "old-remote",
      },
      "remote-2": {
        id: "remote-2",
        path: "docs/deleted.md",
        localPath: "docs/deleted.md",
        md5Checksum: "deleted-remote",
      },
    },
    localFiles: {
      "docs/changed.md": {
        localPath: "docs/changed.md",
        md5: "old-local",
      },
      "docs/deleted.md": {
        localPath: "docs/deleted.md",
        md5: "deleted-local",
      },
    },
  };

  const remoteFiles = [
    {
      id: "remote-1",
      path: "docs/changed.md",
      md5Checksum: "old-remote",
    },
    {
      id: "remote-2",
      path: "docs/deleted.md",
      md5Checksum: "deleted-remote",
    },
  ];

  const localFiles = {
    "docs/changed.md": {
      localPath: "docs/changed.md",
      md5: "new-local",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);
  const changed = diff.changes.find(
    (change) => change.changeType === ChangeType.LOCAL_MODIFIED
  );
  const deleted = diff.changes.find(
    (change) => change.changeType === ChangeType.LOCAL_DELETED
  );

  assert.equal(changed.fileId, "remote-1");
  assert.equal(deleted.fileId, "remote-2");
  assert.equal(deleted.suggestedAction, "delete_remote");
});

test("computeDiff collapses a remote folder rename into one local move", () => {
  const snapshot = {
    files: {
      folder: { id: "folder", path: "old-name", localPath: "old-name", isFolder: true },
      childFolder: { id: "childFolder", path: "old-name/nested", localPath: "old-name/nested", isFolder: true },
      child: { id: "child", path: "old-name/nested/file.txt", localPath: "old-name/nested/file.txt", md5Checksum: "same" },
    },
    localFiles: {
      "old-name": { localPath: "old-name", isFolder: true },
      "old-name/nested": { localPath: "old-name/nested", isFolder: true },
      "old-name/nested/file.txt": { localPath: "old-name/nested/file.txt", md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "folder", path: "new-name", isFolder: true },
    { id: "childFolder", path: "new-name/nested", isFolder: true },
    { id: "child", path: "new-name/nested/file.txt", md5Checksum: "same" },
  ];
  const localFiles = {
    "old-name": { localPath: "old-name", isFolder: true },
    "old-name/nested": { localPath: "old-name/nested", isFolder: true },
    "old-name/nested/file.txt": { localPath: "old-name/nested/file.txt", md5: "same" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })), [
    { changeType: ChangeType.REMOTE_RENAMED, path: "new-name", sourcePath: "old-name" },
  ]);
  assert.equal(diff.changes[0].suggestedAction, "move_local");
});

test("computeDiff preserves separate remote parent and subfolder renames", () => {
  const snapshot = {
    files: {
      parent: { id: "parent", path: "old-parent", isFolder: true },
      child: { id: "child", path: "old-parent/old-child", isFolder: true },
      leaf: { id: "leaf", path: "old-parent/old-child/leaf.txt", md5Checksum: "same" },
    },
    localFiles: {
      "old-parent/old-child/leaf.txt": { md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "parent", path: "new-parent", isFolder: true },
    { id: "child", path: "new-parent/new-child", isFolder: true },
    { id: "leaf", path: "new-parent/new-child/leaf.txt", md5Checksum: "same" },
  ];
  const localFiles = {
    "old-parent/old-child/leaf.txt": { md5: "same" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({
      changeType,
      path,
      sourcePath,
    })),
    [
      {
        changeType: ChangeType.REMOTE_RENAMED,
        path: "new-parent",
        sourcePath: "old-parent",
      },
      {
        changeType: ChangeType.REMOTE_RENAMED,
        path: "new-parent/new-child",
        sourcePath: "old-parent/old-child",
      },
    ]
  );
});

test("computeDiff collapses a local folder rename into one remote rename", () => {
  const snapshot = {
    files: {
      folder: { id: "folder", path: "old-name", localPath: "old-name", isFolder: true },
      child: { id: "child", path: "old-name/file.txt", localPath: "old-name/file.txt", md5Checksum: "same" },
    },
    localFiles: {
      "old-name": { localPath: "old-name", isFolder: true },
      "old-name/file.txt": { localPath: "old-name/file.txt", md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "folder", path: "old-name", isFolder: true },
    { id: "child", path: "old-name/file.txt", md5Checksum: "same" },
  ];
  const localFiles = {
    "new-name": { localPath: "new-name", isFolder: true },
    "new-name/file.txt": { localPath: "new-name/file.txt", md5: "same" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })), [
    { changeType: ChangeType.LOCAL_RENAMED, path: "new-name", sourcePath: "old-name" },
  ]);
  assert.equal(diff.changes[0].suggestedAction, "rename_remote");
});

test("computeDiff preserves separate local parent and subfolder renames", () => {
  const snapshot = {
    files: {
      parent: { id: "parent", path: "old-parent", isFolder: true },
      child: { id: "child", path: "old-parent/old-child", isFolder: true },
      leaf: { id: "leaf", path: "old-parent/old-child/leaf.txt", md5Checksum: "same" },
    },
    localFiles: {
      "old-parent/old-child/leaf.txt": { md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "parent", path: "old-parent", isFolder: true },
    { id: "child", path: "old-parent/old-child", isFolder: true },
    { id: "leaf", path: "old-parent/old-child/leaf.txt", md5Checksum: "same" },
  ];
  const localFiles = {
    "new-parent/new-child/leaf.txt": { md5: "same" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({
      changeType,
      path,
      sourcePath,
    })),
    [
      {
        changeType: ChangeType.LOCAL_RENAMED,
        path: "new-parent",
        sourcePath: "old-parent",
      },
      {
        changeType: ChangeType.LOCAL_RENAMED,
        path: "new-parent/new-child",
        sourcePath: "old-parent/old-child",
      },
    ]
  );
});

test("computeDiff reports a local file rename and remote deletion as a conflict", () => {
  const snapshot = {
    files: {
      file: {
        id: "file",
        path: "old-name.txt",
        md5Checksum: "same",
      },
    },
    localFiles: {
      "old-name.txt": { md5: "same" },
    },
  };
  const localFiles = {
    "new-name.txt": { md5: "same" },
  };

  const diff = computeDiff(snapshot, [], localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({
      changeType,
      path,
      sourcePath,
    })),
    [
      {
        changeType: ChangeType.CONFLICT,
        path: "new-name.txt",
        sourcePath: "old-name.txt",
      },
    ]
  );
});

test("computeDiff reports a remote file rename and local deletion as a conflict", () => {
  const snapshot = {
    files: {
      file: {
        id: "file",
        path: "old-name.txt",
        md5Checksum: "same",
      },
    },
    localFiles: {
      "old-name.txt": { md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "file", path: "new-name.txt", md5Checksum: "same" },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({
      changeType,
      path,
      sourcePath,
    })),
    [
      {
        changeType: ChangeType.CONFLICT,
        path: "new-name.txt",
        sourcePath: "old-name.txt",
      },
    ]
  );
});

test("computeDiff does not churn descendants when a folder rename already converged", () => {
  const snapshot = {
    files: {
      folder: { id: "folder", path: "01_Courses", localPath: "01_Courses", isFolder: true },
      child: { id: "child", path: "01_Courses/notes.md", localPath: "01_Courses/notes.md", md5Checksum: "same" },
    },
    localFiles: {
      "01_Courses": { localPath: "01_Courses", isFolder: true },
      "01_Courses/notes.md": { localPath: "01_Courses/notes.md", md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "folder", path: "Courses", isFolder: true },
    { id: "child", path: "Courses/notes.md", md5Checksum: "same" },
  ];
  const localFiles = {
    Courses: { localPath: "Courses", isFolder: true },
    "Courses/notes.md": { localPath: "Courses/notes.md", md5: "same" },
  };

  assert.deepEqual(computeDiff(snapshot, remoteFiles, localFiles).changes, []);
});

test("computeDiff infers a remote folder rename from descendant IDs in legacy snapshots", () => {
  const snapshot = {
    // Older snapshots tracked only files inside non-empty folders.
    files: {
      child: { id: "child", path: "01_Courses/notes.md", localPath: "01_Courses/notes.md", md5Checksum: "same" },
    },
    localFiles: {
      "01_Courses/notes.md": { localPath: "01_Courses/notes.md", md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "folder", path: "Courses", isFolder: true },
    { id: "child", path: "Courses/notes.md", md5Checksum: "same" },
  ];
  const localFiles = {
    "01_Courses/notes.md": { localPath: "01_Courses/notes.md", md5: "same" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);
  assert.deepEqual(diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })), [
    { changeType: ChangeType.REMOTE_RENAMED, path: "Courses", sourcePath: "01_Courses" },
  ]);
});

test("computeDiff treats same-path remote ID replacement as a modification", () => {
  const snapshot = {
    files: {
      "old-remote-id": {
        id: "old-remote-id",
        path: "docs/report.md",
        localPath: "docs/report.md",
        md5Checksum: "old-md5",
      },
    },
    localFiles: {
      "docs/report.md": {
        localPath: "docs/report.md",
        md5: "old-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "new-remote-id",
      path: "docs/report.md",
      md5Checksum: "new-md5",
    },
  ];

  const localFiles = {
    "docs/report.md": {
      localPath: "docs/report.md",
      md5: "old-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_MODIFIED]
  );
  assert.equal(diff.changes[0].fileId, "new-remote-id");
  assert.equal(diff.changes[0].suggestedAction, "download");
});

test("computeDiff refreshes same-path remote ID replacement with unchanged content", () => {
  const snapshot = {
    files: {
      "old-remote-id": {
        id: "old-remote-id",
        path: "docs/report.md",
        localPath: "docs/report.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {
      "docs/report.md": {
        localPath: "docs/report.md",
        md5: "same-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "new-remote-id",
      path: "docs/report.md",
      md5Checksum: "same-md5",
    },
  ];

  const localFiles = {
    "docs/report.md": {
      localPath: "docs/report.md",
      md5: "same-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_MODIFIED]
  );
  assert.equal(diff.changes[0].fileId, "new-remote-id");
  assert.equal(diff.changes[0].suggestedAction, "download");
});

test("computeDiff downloads remote snapshot entries that are absent from the local baseline", () => {
  const snapshot = {
    files: {
      "remote-only": {
        id: "remote-only",
        path: "Planning/Atlas/note.md",
        md5Checksum: "remote-md5",
      },
    },
    localFiles: {},
  };

  const remoteFiles = [
    {
      id: "remote-only",
      path: "Planning/Atlas/note.md",
      md5Checksum: "remote-md5",
    },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_ADDED]
  );
  assert.equal(diff.changes[0].path, "Planning/Atlas/note.md");
  assert.equal(diff.changes[0].fileId, "remote-only");
  assert.equal(diff.changes[0].suggestedAction, "download");
});

test("changesWithLocalAuthority converts remote-only additions into remote deletes", () => {
  const remoteOnly = {
    changeType: ChangeType.REMOTE_ADDED,
    path: "docs/remote-only.md",
    fileId: "remote-only",
    remoteMeta: { id: "remote-only", path: "docs/remote-only.md" },
    localMeta: null,
    snapshotMeta: null,
    shortStatus: "+R",
    description: "new on Drive",
    suggestedAction: "download",
  };

  const changes = changesWithLocalAuthority([remoteOnly]);

  assert.deepEqual(changes, [
    {
      changeType: ChangeType.LOCAL_DELETED,
      path: "docs/remote-only.md",
      fileId: "remote-only",
      remoteMeta: { id: "remote-only", path: "docs/remote-only.md" },
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "-L",
      description: "deleted locally",
      suggestedAction: "delete_remote",
    },
  ]);
});

test("changesWithLocalAuthority collapses remote-only paths to missing local ancestors", () => {
  const remoteOnly = {
    changeType: ChangeType.REMOTE_ADDED,
    path: "docs/generated/build/output.o",
    fileId: "remote-child",
    remoteMeta: { id: "remote-child", path: "docs/generated/build/output.o" },
    localMeta: null,
    snapshotMeta: null,
    shortStatus: "+R",
    description: "new on Drive",
    suggestedAction: "download",
  };
  const existingPaths = new Set(["docs"]);

  const changes = changesWithLocalAuthority([remoteOnly], {
    pathExists: (candidate) => existingPaths.has(candidate),
  });

  assert.deepEqual(changes, [
    {
      changeType: ChangeType.LOCAL_DELETED,
      path: "docs/generated",
      fileId: null,
      remoteMeta: null,
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "-L",
      description: "deleted locally",
      suggestedAction: "delete_remote",
    },
  ]);
});

test("changesWithLocalAuthority deduplicates collapsed remote deletes", () => {
  const remoteChanges = [
    {
      changeType: ChangeType.REMOTE_ADDED,
      path: "docs/generated/build/a.o",
      fileId: "remote-a",
      remoteMeta: { id: "remote-a", path: "docs/generated/build/a.o" },
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "+R",
      description: "new on Drive",
      suggestedAction: "download",
    },
    {
      changeType: ChangeType.REMOTE_ADDED,
      path: "docs/generated/build/b.o",
      fileId: "remote-b",
      remoteMeta: { id: "remote-b", path: "docs/generated/build/b.o" },
      localMeta: null,
      snapshotMeta: null,
      shortStatus: "+R",
      description: "new on Drive",
      suggestedAction: "download",
    },
  ];
  const existingPaths = new Set(["docs"]);

  const changes = changesWithLocalAuthority(remoteChanges, {
    pathExists: (candidate) => existingPaths.has(candidate),
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "docs/generated");
});

test("computeDiff conflicts when remote baseline-only file differs from local file", () => {
  const snapshot = {
    files: {
      "remote-only": {
        id: "remote-only",
        path: "Planning/overview.md",
        md5Checksum: "remote-md5",
      },
    },
    localFiles: {},
  };

  const remoteFiles = [
    {
      id: "remote-only",
      path: "Planning/overview.md",
      md5Checksum: "remote-md5",
    },
  ];

  const localFiles = {
    "Planning/overview.md": {
      localPath: "Planning/overview.md",
      md5: "local-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.CONFLICT]
  );
  assert.equal(diff.changes[0].path, "Planning/overview.md");
  assert.equal(diff.changes[0].fileId, "remote-only");
  assert.equal(diff.changes[0].suggestedAction, "conflict");
  assert.equal(diff.changes[0].remoteMeta.md5Checksum, "remote-md5");
  assert.equal(diff.changes[0].localMeta.md5, "local-md5");
});

test("computeDiff does not upload duplicate local files when remote baseline-only content matches", () => {
  const snapshot = {
    files: {
      "remote-only": {
        id: "remote-only",
        path: "Planning/overview.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {},
  };

  const remoteFiles = [
    {
      id: "remote-only",
      path: "Planning/overview.md",
      md5Checksum: "same-md5",
    },
  ];

  const localFiles = {
    "Planning/overview.md": {
      localPath: "Planning/overview.md",
      md5: "same-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(diff.changes, []);
});

test("computeDiff keeps local deletion semantics for files that were synced locally", () => {
  const snapshot = {
    files: {
      "synced-remote": {
        id: "synced-remote",
        path: "docs/synced.md",
        localPath: "docs/synced.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {
      "docs/synced.md": {
        localPath: "docs/synced.md",
        md5: "same-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "synced-remote",
      path: "docs/synced.md",
      md5Checksum: "same-md5",
    },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.LOCAL_DELETED]
  );
  assert.equal(diff.changes[0].suggestedAction, "delete_remote");
});

test("computeDiff collapses local deletion of non-empty remote folder to parent folder delete", () => {
  const snapshot = {
    files: {
      "remote-folder": {
        id: "remote-folder",
        path: "build/app.dSYM",
        localPath: "build/app.dSYM",
        isFolder: true,
      },
      "remote-info": {
        id: "remote-info",
        path: "build/app.dSYM/Contents/Info.plist",
        localPath: "build/app.dSYM/Contents/Info.plist",
        md5Checksum: "info-md5",
      },
      "remote-binary": {
        id: "remote-binary",
        path: "build/app.dSYM/Contents/Resources/DWARF/app",
        localPath: "build/app.dSYM/Contents/Resources/DWARF/app",
        md5Checksum: "binary-md5",
      },
      "remote-keep": {
        id: "remote-keep",
        path: "build/keep.txt",
        localPath: "build/keep.txt",
        md5Checksum: "keep-md5",
      },
    },
    localFiles: {
      "build/app.dSYM/Contents/Info.plist": {
        localPath: "build/app.dSYM/Contents/Info.plist",
        md5: "info-md5",
      },
      "build/app.dSYM/Contents/Resources/DWARF/app": {
        localPath: "build/app.dSYM/Contents/Resources/DWARF/app",
        md5: "binary-md5",
      },
      "build/keep.txt": {
        localPath: "build/keep.txt",
        md5: "keep-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "remote-folder",
      path: "build/app.dSYM",
      isFolder: true,
    },
    {
      id: "remote-info",
      path: "build/app.dSYM/Contents/Info.plist",
      md5Checksum: "info-md5",
    },
    {
      id: "remote-binary",
      path: "build/app.dSYM/Contents/Resources/DWARF/app",
      md5Checksum: "binary-md5",
    },
    {
      id: "remote-keep",
      path: "build/keep.txt",
      md5Checksum: "keep-md5",
    },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {
    "build/keep.txt": { localPath: "build/keep.txt", md5: "keep-md5" },
  });

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      fileId: change.fileId,
    })),
    [
      {
        type: ChangeType.LOCAL_DELETED,
        path: "build/app.dSYM",
        action: "delete_remote",
        fileId: "remote-folder",
      },
    ]
  );
});

test("computeDiff deletes the folder itself when a locally deleted folder is only implicit", () => {
  // Non-empty folders appear in neither the remote listing nor the local
  // scan, so a deleted local folder used to surface only its files — the
  // trashed files then left an empty folder husk behind on Drive.
  const snapshot = {
    files: {
      "remote-file": {
        id: "remote-file",
        path: "notes/deep/todo.md",
        localPath: "notes/deep/todo.md",
        md5Checksum: "todo-md5",
      },
      "remote-keep": {
        id: "remote-keep",
        path: "keep.txt",
        localPath: "keep.txt",
        md5Checksum: "keep-md5",
      },
    },
    localFiles: {
      "notes/deep/todo.md": {
        localPath: "notes/deep/todo.md",
        md5: "todo-md5",
      },
      "keep.txt": { localPath: "keep.txt", md5: "keep-md5" },
    },
  };

  const remoteFiles = [
    { id: "remote-file", path: "notes/deep/todo.md", md5Checksum: "todo-md5" },
    { id: "remote-keep", path: "keep.txt", md5Checksum: "keep-md5" },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {
    "keep.txt": { localPath: "keep.txt", md5: "keep-md5" },
  });

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      fileId: change.fileId,
    })),
    [
      {
        type: ChangeType.LOCAL_DELETED,
        path: "notes",
        action: "delete_remote",
        fileId: null,
      },
    ]
  );
});

test("computeDiff keeps a remotely edited file out of a locally deleted folder's collapse", () => {
  const snapshot = {
    files: {
      "remote-file": {
        id: "remote-file",
        path: "notes/todo.md",
        localPath: "notes/todo.md",
        md5Checksum: "old-md5",
      },
    },
    localFiles: {
      "notes/todo.md": { localPath: "notes/todo.md", md5: "old-md5" },
    },
  };

  const remoteFiles = [
    { id: "remote-file", path: "notes/todo.md", md5Checksum: "new-md5" },
  ];

  const diff = computeDiff(snapshot, remoteFiles, {});

  // The remote edit must surface as a conflict; the folder deletion must not
  // trash the edited file behind the user's back.
  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
    })),
    [{ type: ChangeType.CONFLICT, path: "notes/todo.md" }]
  );
});

test("computeDiff treats remote additions under a locally deleted snapshot folder as parent folder delete", () => {
  const snapshot = {
    files: {},
    localFiles: {
      "01_Courses/00_Compiler/IC_Lab/specs/lab1.pdf": {
        localPath: "01_Courses/00_Compiler/IC_Lab/specs/lab1.pdf",
        md5: "lab-md5",
      },
      "01_Courses/00_Compiler/cbc-1.0/import/sys": {
        localPath: "01_Courses/00_Compiler/cbc-1.0/import/sys",
        md5: "sys-md5",
      },
      "01_Courses/03_C/AP325/main.c": {
        localPath: "01_Courses/03_C/AP325/main.c",
        md5: "other-course-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "compiler-folder",
      path: "01_Courses/00_Compiler",
      isFolder: true,
    },
    {
      id: "specs-folder",
      path: "01_Courses/00_Compiler/IC_Lab/specs",
      isFolder: true,
    },
    {
      id: "lab-file",
      path: "01_Courses/00_Compiler/IC_Lab/specs/lab1.pdf",
      md5Checksum: "lab-md5",
    },
    {
      id: "sys-file",
      path: "01_Courses/00_Compiler/cbc-1.0/import/sys",
      md5Checksum: "sys-md5",
    },
  ];

  const localFiles = {
    "01_Courses/03_C/AP325/main.c": {
      localPath: "01_Courses/03_C/AP325/main.c",
      md5: "other-course-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      fileId: change.fileId,
    })),
    [
      {
        type: ChangeType.LOCAL_DELETED,
        path: "01_Courses/00_Compiler",
        action: "delete_remote",
        fileId: "compiler-folder",
      },
    ]
  );
});

test("computeDiff ignores files deleted on both local and Drive", () => {
  const snapshot = {
    files: {
      "synced-remote": {
        id: "synced-remote",
        path: "docs/deleted.md",
        localPath: "docs/deleted.md",
        md5Checksum: "same-md5",
      },
    },
    localFiles: {
      "docs/deleted.md": {
        localPath: "docs/deleted.md",
        md5: "same-md5",
      },
    },
  };

  const diff = computeDiff(snapshot, [], {});

  assert.deepEqual(diff.changes, []);
});

test("computeDiff ignores folders deleted on both local and Drive", () => {
  const snapshot = {
    files: {
      "folder-remote": {
        id: "folder-remote",
        path: "docs/archive",
        localPath: "docs/archive",
        isFolder: true,
      },
    },
    localFiles: {
      "docs/archive": {
        localPath: "docs/archive",
        isFolder: true,
      },
    },
  };

  const diff = computeDiff(snapshot, [], {});

  assert.deepEqual(diff.changes, []);
});

test("computeDiff lets remote-deleted folders delete matching local folders without local baseline", () => {
  const snapshot = {
    files: {
      "folder-remote": {
        id: "folder-remote",
        path: "docs/generated",
        localPath: "docs/generated",
        isFolder: true,
      },
    },
    localFiles: {},
  };

  const localFiles = {
    "docs/generated": {
      localPath: "docs/generated",
      isFolder: true,
    },
  };

  const diff = computeDiff(snapshot, [], localFiles);

  assert.deepEqual(
    diff.changes.map((change) => change.changeType),
    [ChangeType.REMOTE_DELETED]
  );
  assert.equal(diff.changes[0].path, "docs/generated");
  assert.equal(diff.changes[0].suggestedAction, "delete_local");
});

test("computeDiff collapses remote deletion of non-empty folder to parent local delete", () => {
  const snapshot = {
    files: {
      "remote-a": {
        id: "remote-a",
        path: "courses/compiler/specs/lab1.pdf",
        localPath: "courses/compiler/specs/lab1.pdf",
        md5Checksum: "lab-md5",
      },
      "remote-b": {
        id: "remote-b",
        path: "courses/compiler/src/main.c",
        localPath: "courses/compiler/src/main.c",
        md5Checksum: "main-md5",
      },
      "remote-sibling": {
        id: "remote-sibling",
        path: "courses/math/notes.md",
        localPath: "courses/math/notes.md",
        md5Checksum: "math-md5",
      },
    },
    localFiles: {
      "courses/compiler/specs/lab1.pdf": {
        localPath: "courses/compiler/specs/lab1.pdf",
        md5: "lab-md5",
      },
      "courses/compiler/src/main.c": {
        localPath: "courses/compiler/src/main.c",
        md5: "main-md5",
      },
      "courses/math/notes.md": {
        localPath: "courses/math/notes.md",
        md5: "math-md5",
      },
    },
  };

  const remoteFiles = [
    {
      id: "remote-sibling",
      path: "courses/math/notes.md",
      md5Checksum: "math-md5",
    },
  ];

  const localFiles = {
    "courses/compiler/specs/lab1.pdf": {
      localPath: "courses/compiler/specs/lab1.pdf",
      md5: "lab-md5",
    },
    "courses/compiler/src/main.c": {
      localPath: "courses/compiler/src/main.c",
      md5: "main-md5",
    },
    "courses/math/notes.md": {
      localPath: "courses/math/notes.md",
      md5: "math-md5",
    },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map((change) => ({
      type: change.changeType,
      path: change.path,
      action: change.suggestedAction,
      isFolder: change.snapshotMeta?.isFolder,
    })),
    [
      {
        type: ChangeType.REMOTE_DELETED,
        path: "courses/compiler",
        action: "delete_local",
        isFolder: true,
      },
    ]
  );
});

test("computeDiff ignores historical snapshot entries that now match .aethelignore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aethel-diff-"));

  try {
    fs.writeFileSync(path.join(root, ".aethelignore"), "Debug/\n");

    const snapshot = {
      files: {
        "remote-debug": {
          id: "remote-debug",
          path: "project/Debug/build.o",
          localPath: "project/Debug/build.o",
          md5Checksum: "debug-md5",
        },
      },
      localFiles: {
        "project/Debug/build.o": {
          localPath: "project/Debug/build.o",
          md5: "debug-md5",
        },
      },
    };

    const remoteFiles = [
      {
        id: "remote-debug",
        path: "project/Debug/build.o",
        md5Checksum: "debug-md5",
      },
    ];

    const localFiles = {
      "project/Debug/build.o": {
        localPath: "project/Debug/build.o",
        md5: "changed-debug-md5",
      },
    };

    const diff = computeDiff(snapshot, remoteFiles, localFiles, { root });

    assert.deepEqual(diff.changes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Folder rename + concurrent edits (two-machine scenarios) ─────────

test("computeDiff keeps a local edit uploadable through a pulled remote folder rename", () => {
  // Machine 1 renamed docs/ -> archive/ on Drive; machine 2 edited a file
  // inside docs/ locally. The rename must become one local move, and the
  // edit must stay staged as an upload that targets the file's NEW remote
  // location — not the stale pre-rename path.
  const snapshot = {
    files: {
      child: { id: "child", path: "docs/notes.md", localPath: "docs/notes.md", md5Checksum: "base" },
    },
    localFiles: {
      "docs/notes.md": { localPath: "docs/notes.md", md5: "base" },
    },
  };
  const remoteFiles = [
    { id: "child", path: "archive/notes.md", md5Checksum: "base" },
  ];
  const localFiles = {
    docs: { localPath: "docs", isFolder: true },
    "docs/notes.md": { localPath: "docs/notes.md", md5: "edited" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })),
    [
      { changeType: ChangeType.REMOTE_RENAMED, path: "archive", sourcePath: "docs" },
      { changeType: ChangeType.LOCAL_MODIFIED, path: "docs/notes.md", sourcePath: undefined },
    ]
  );
  assert.equal(diff.conflicts.length, 0);

  const upload = diff.changes.find((change) => change.changeType === ChangeType.LOCAL_MODIFIED);
  assert.equal(upload.fileId, "child");
  assert.equal(upload.remoteMeta?.path, "archive/notes.md");
});

test("computeDiff detects a local rename of a non-empty folder without folder IDs", () => {
  // Non-empty folders are absent from remote listings and snapshots; the
  // rename must still be recognized from the implicit baseline folder and
  // pushed as a remote rename (ID resolved at execution time).
  const snapshot = {
    files: {
      child: { id: "child", path: "docs/notes.md", localPath: "docs/notes.md", md5Checksum: "same" },
    },
    localFiles: {
      "docs/notes.md": { localPath: "docs/notes.md", md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "child", path: "docs/notes.md", md5Checksum: "same" },
  ];
  const localFiles = {
    archive: { localPath: "archive", isFolder: true },
    "archive/notes.md": { localPath: "archive/notes.md", md5: "same" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })),
    [{ changeType: ChangeType.LOCAL_RENAMED, path: "archive", sourcePath: "docs" }]
  );
  assert.equal(diff.changes[0].suggestedAction, "rename_remote");
});

test("computeDiff keeps a local rename detected when some files inside were also edited", () => {
  const snapshot = {
    files: {
      a: { id: "a", path: "docs/kept.md", localPath: "docs/kept.md", md5Checksum: "same" },
      b: { id: "b", path: "docs/edited.md", localPath: "docs/edited.md", md5Checksum: "base" },
    },
    localFiles: {
      "docs/kept.md": { localPath: "docs/kept.md", md5: "same" },
      "docs/edited.md": { localPath: "docs/edited.md", md5: "base" },
    },
  };
  const remoteFiles = [
    { id: "a", path: "docs/kept.md", md5Checksum: "same" },
    { id: "b", path: "docs/edited.md", md5Checksum: "base" },
  ];
  const localFiles = {
    archive: { localPath: "archive", isFolder: true },
    "archive/kept.md": { localPath: "archive/kept.md", md5: "same" },
    "archive/edited.md": { localPath: "archive/edited.md", md5: "edited" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })),
    [
      { changeType: ChangeType.LOCAL_RENAMED, path: "archive", sourcePath: "docs" },
      { changeType: ChangeType.LOCAL_MODIFIED, path: "archive/edited.md", sourcePath: undefined },
    ]
  );
  assert.equal(diff.conflicts.length, 0);

  const upload = diff.changes.find((change) => change.changeType === ChangeType.LOCAL_MODIFIED);
  assert.equal(upload.fileId, "b");
  // The upload still targets the file's current remote location (pre-rename);
  // the executor remaps it after the staged remote rename runs.
  assert.equal(upload.remoteMeta?.path, "docs/edited.md");
});

test("computeDiff downloads a remote edit into the locally renamed folder", () => {
  // Machine 2 renamed docs/ -> archive/ locally; machine 1 edited a file on
  // Drive. The download must land inside the renamed local tree instead of
  // recreating the old docs/ directory.
  const snapshot = {
    files: {
      child: { id: "child", path: "docs/notes.md", localPath: "docs/notes.md", md5Checksum: "base" },
    },
    localFiles: {
      "docs/notes.md": { localPath: "docs/notes.md", md5: "base" },
    },
  };
  const remoteFiles = [
    { id: "child", path: "docs/notes.md", md5Checksum: "remote-edit" },
  ];
  const localFiles = {
    archive: { localPath: "archive", isFolder: true },
    "archive/notes.md": { localPath: "archive/notes.md", md5: "base" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path, sourcePath }) => ({ changeType, path, sourcePath })),
    [
      { changeType: ChangeType.LOCAL_RENAMED, path: "archive", sourcePath: "docs" },
      { changeType: ChangeType.REMOTE_MODIFIED, path: "docs/notes.md", sourcePath: undefined },
    ]
  );
  assert.equal(diff.conflicts.length, 0);

  const download = diff.changes.find((change) => change.changeType === ChangeType.REMOTE_MODIFIED);
  assert.equal(download.localMeta?.localPath, "archive/notes.md");
});

test("computeDiff promotes a moved-and-modified file edited on both sides to one conflict", () => {
  // Machine 1 renamed the folder AND edited the file; machine 2 edited the
  // same file. Staging a download and an upload for the same Drive file
  // would race — this must surface as a single conflict instead.
  const snapshot = {
    files: {
      child: { id: "child", path: "docs/notes.md", localPath: "docs/notes.md", md5Checksum: "base" },
    },
    localFiles: {
      "docs/notes.md": { localPath: "docs/notes.md", md5: "base" },
    },
  };
  const remoteFiles = [
    { id: "child", path: "archive/notes.md", md5Checksum: "remote-edit" },
  ];
  const localFiles = {
    docs: { localPath: "docs", isFolder: true },
    "docs/notes.md": { localPath: "docs/notes.md", md5: "local-edit" },
  };

  const diff = computeDiff(snapshot, remoteFiles, localFiles);

  assert.deepEqual(
    diff.changes.map(({ changeType, path }) => ({ changeType, path })),
    [
      { changeType: ChangeType.REMOTE_RENAMED, path: "archive" },
      { changeType: ChangeType.CONFLICT, path: "docs/notes.md" },
    ]
  );

  const conflict = diff.conflicts[0];
  assert.equal(conflict.fileId, "child");
  assert.equal(conflict.remoteMeta?.path, "archive/notes.md");
  assert.equal(conflict.localMeta?.md5, "local-edit");
});

test("computeDiff stays quiet when both sides renamed a non-empty folder identically", () => {
  const snapshot = {
    files: {
      child: { id: "child", path: "docs/notes.md", localPath: "docs/notes.md", md5Checksum: "same" },
    },
    localFiles: {
      "docs/notes.md": { localPath: "docs/notes.md", md5: "same" },
    },
  };
  const remoteFiles = [
    { id: "child", path: "archive/notes.md", md5Checksum: "same" },
  ];
  const localFiles = {
    archive: { localPath: "archive", isFolder: true },
    "archive/notes.md": { localPath: "archive/notes.md", md5: "same" },
  };

  assert.deepEqual(computeDiff(snapshot, remoteFiles, localFiles).changes, []);
});
