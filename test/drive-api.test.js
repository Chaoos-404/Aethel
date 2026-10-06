import assert from "node:assert/strict";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { initWorkspace, readIndex, writeIndex, writeSnapshot } from "../src/core/config.js";
import {
  dedupeDuplicateFiles,
  dedupeDuplicateFolders,
  ensureFolder,
  getRemoteState,
  listIgnoredRemoteItems,
  resetFolderLookupCache,
  syncLocalDirectoryToParent,
  downloadFile,
  uploadFile,
  uploadLocalEntry,
  withDriveRetry,
} from "../src/core/drive-api.js";
import { executeStaged } from "../src/core/sync.js";
import { createTempDirectory } from "../test-support/workspace.js";

import { FOLDER_MIME, folder, file, md5, createFakeDrive } from "../test-support/fake-drive.js";

/**
 * True when the drive was asked for a whole-drive listing. The global fetch
 * pages folders and files as two concurrent queries, so match on the shape
 * rather than one exact string.
 */
function performedGlobalListing(drive) {
  return drive.listQueries().some((query) => query.startsWith("trashed = false"));
}

/** How many whole-drive listings ran (one folder query per listing). */
function globalListingCount(drive) {
  return drive
    .listQueries()
    .filter((query) => query === `trashed = false and mimeType = '${FOLDER_MIME}'`).length;
}

function buildNestedDuplicateItems() {
  return [
    folder("top-a", "其他", "root", "2026-04-04T10:32:21.468Z"),
    folder("top-b", "其他", "root", "2026-04-04T10:32:21.495Z"),
    folder("docs-a", "docs", "top-a", "2026-04-04T10:33:00.000Z"),
    folder("docs-b", "docs", "top-b", "2026-04-04T10:33:05.000Z"),
    file("same-a", "same.txt", "docs-a", "2026-04-04T10:34:00.000Z", "same"),
    file("same-b", "same.txt", "docs-b", "2026-04-04T10:34:01.000Z", "same"),
    file("move-b", "move.txt", "docs-b", "2026-04-04T10:34:02.000Z", "move"),
    file("root-b", "root-only.txt", "top-b", "2026-04-04T10:34:03.000Z", "root"),
  ];
}

test.beforeEach(() => {
  resetFolderLookupCache();
});

test("ensureFolder creates one folder for concurrent callers", async () => {
  const drive = createFakeDrive([], { listDelayMs: 20 });
  const ids = await Promise.all(
    Array.from({ length: 8 }, () => ensureFolder(drive, "其他", null))
  );

  assert.equal(new Set(ids).size, 1);
  const folders = drive
    .snapshot()
    .filter(
      (item) =>
        item.mimeType === FOLDER_MIME &&
        !item.trashed &&
        item.name === "其他" &&
        item.parents.includes("root")
    );
  assert.equal(folders.length, 1);
});

test("ensureFolder reuses the canonical existing duplicate", async () => {
  const drive = createFakeDrive([
    folder("older", "其他", "root", "2026-04-04T10:32:21.468Z"),
    folder("newer", "其他", "root", "2026-04-04T10:32:21.493Z"),
    folder("newest", "其他", "root", "2026-04-04T10:32:21.495Z"),
  ]);

  const id = await ensureFolder(drive, "其他", null);

  assert.equal(id, "older");
  const folders = drive
    .snapshot()
    .filter((item) => item.mimeType === FOLDER_MIME && item.name === "其他");
  assert.equal(folders.length, 3);
});

test("dedupeDuplicateFolders dry-run reports duplicates without mutating", async () => {
  const drive = createFakeDrive(buildNestedDuplicateItems());
  const before = drive.snapshot();

  const result = await dedupeDuplicateFolders(drive, null, { execute: false });

  assert.equal(result.duplicateFolders.length, 1);
  assert.equal(result.remainingDuplicateFolders.length, 1);
  assert.deepEqual(drive.snapshot(), before);
});

test("dedupeDuplicateFolders merges nested folders and trashes empty losers", async () => {
  const drive = createFakeDrive(buildNestedDuplicateItems());

  const result = await dedupeDuplicateFolders(drive, null, { execute: true });

  assert.equal(result.movedItems, 2);
  assert.equal(result.trashedDuplicateFiles, 1);
  assert.equal(result.trashedFolders, 2);
  assert.equal(result.remainingDuplicateFolders.length, 0);

  const snapshot = drive.snapshot();
  const liveTopFolders = snapshot.filter(
    (item) =>
      item.mimeType === FOLDER_MIME &&
      !item.trashed &&
      item.name === "其他" &&
      item.parents.includes("root")
  );
  assert.equal(liveTopFolders.length, 1);

  const liveDocsFolders = snapshot.filter(
    (item) =>
      item.mimeType === FOLDER_MIME &&
      !item.trashed &&
      item.name === "docs" &&
      item.parents.includes("top-a")
  );
  assert.equal(liveDocsFolders.length, 1);

  const liveFiles = snapshot.filter((item) => !item.trashed && item.mimeType !== FOLDER_MIME);
  assert.equal(liveFiles.some((item) => item.name === "root-only.txt" && item.parents[0] === "top-a"), true);
  assert.equal(liveFiles.some((item) => item.name === "move.txt" && item.parents[0] === "docs-a"), true);
  assert.equal(snapshot.find((item) => item.id === "same-b").trashed, true);
  assert.equal(globalListingCount(drive), 2);
});

test("dedupeDuplicateFolders leaves conflicting duplicates in place", async () => {
  const drive = createFakeDrive([
    folder("top-a", "其他", "root", "2026-04-04T10:32:21.468Z"),
    folder("top-b", "其他", "root", "2026-04-04T10:32:21.495Z"),
    file("conflict-a", "conflict.txt", "top-a", "2026-04-04T10:34:00.000Z", "aaa"),
    file("conflict-b", "conflict.txt", "top-b", "2026-04-04T10:34:01.000Z", "bbb"),
  ]);

  const result = await dedupeDuplicateFolders(drive, null, { execute: true });

  assert.equal(result.skippedConflicts, 1);
  assert.equal(result.remainingDuplicateFolders.length, 1);
  assert.equal(drive.snapshot().find((item) => item.id === "top-b").trashed, false);
});

test("dedupeDuplicateFiles dry-run reports duplicates without mutating", async () => {
  const drive = createFakeDrive([
    file("old", "report.md", "root", "2026-04-04T10:34:00.000Z", "old"),
    file("latest", "report.md", "root", "2026-04-04T10:35:00.000Z", "latest"),
    file("other", "other.md", "root", "2026-04-04T10:36:00.000Z", "other"),
  ]);
  const before = drive.snapshot();

  const result = await dedupeDuplicateFiles(drive, null, { execute: false });

  assert.equal(result.duplicateFiles.length, 1);
  assert.equal(result.duplicateFiles[0].latest.id, "latest");
  assert.deepEqual(result.duplicateFiles[0].older.map((item) => item.id), ["old"]);
  assert.equal(result.remainingDuplicateFiles.length, 1);
  assert.deepEqual(drive.snapshot(), before);
});

test("dedupeDuplicateFiles keeps latest modified file and trashes older copies", async () => {
  const drive = createFakeDrive([
    file("old", "report.md", "root", "2026-04-04T10:34:00.000Z", "old"),
    file("latest", "report.md", "root", "2026-04-04T10:36:00.000Z", "latest"),
    file("middle", "report.md", "root", "2026-04-04T10:35:00.000Z", "middle"),
    folder("docs", "docs", "root", "2026-04-04T10:30:00.000Z"),
    file("nested-old", "report.md", "docs", "2026-04-04T10:31:00.000Z", "nested-old"),
    file("nested-latest", "report.md", "docs", "2026-04-04T10:32:00.000Z", "nested-latest"),
  ]);

  const result = await dedupeDuplicateFiles(drive, null, { execute: true });

  assert.equal(result.duplicateFiles.length, 2);
  assert.equal(result.keptFiles, 2);
  assert.equal(result.trashedFiles, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(result.remainingDuplicateFiles.length, 0);

  const snapshot = drive.snapshot();
  const liveReports = snapshot.filter(
    (item) => item.name === "report.md" && !item.trashed
  );
  assert.deepEqual(liveReports.map((item) => item.id).sort(), [
    "latest",
    "nested-latest",
  ]);
  assert.equal(snapshot.find((item) => item.id === "old").trashed, true);
  assert.equal(snapshot.find((item) => item.id === "middle").trashed, true);
  assert.equal(snapshot.find((item) => item.id === "nested-old").trashed, true);
});

test("getRemoteState walks only the configured Drive folder tree", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    folder("docs", "docs", "project", "2026-04-04T10:01:00.000Z"),
    file("inside", "inside.txt", "docs", "2026-04-04T10:02:00.000Z", "inside"),
    file("root-child", "root-child.txt", "project", "2026-04-04T10:02:30.000Z", "root-child"),
    folder("empty", "empty", "project", "2026-04-04T10:03:00.000Z"),
    folder("outside", "Outside", "real-my-drive-root", "2026-04-04T10:04:00.000Z"),
    file("outside-file", "outside.txt", "outside", "2026-04-04T10:05:00.000Z", "outside"),
  ]);

  const remoteState = await getRemoteState(drive, "project");

  assert.deepEqual(
    remoteState.files.map((item) => item.path).sort(),
    ["docs/inside.txt", "empty", "root-child.txt"]
  );
  assert.equal(
    performedGlobalListing(drive),
    false
  );
  assert.deepEqual(drive.listQueries().filter((query) => query.includes(" in parents ")), [
    "'project' in parents and trashed = false",
    "'docs' in parents and trashed = false",
    "'empty' in parents and trashed = false",
  ]);
});

test("getRemoteState uses global fetch for large configured folder snapshots", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    folder("docs", "docs", "project", "2026-04-04T10:01:00.000Z"),
    file("inside", "inside.txt", "docs", "2026-04-04T10:02:00.000Z", "inside"),
    folder("outside", "Outside", "real-my-drive-root", "2026-04-04T10:04:00.000Z"),
    file("outside-file", "outside.txt", "outside", "2026-04-04T10:05:00.000Z", "outside"),
  ]);

  const remoteState = await getRemoteState(drive, "project", null, {
    estimatedRemoteFiles: 50_000,
  });

  assert.deepEqual(remoteState.files.map((item) => item.path), ["docs/inside.txt"]);
  assert.equal(
    performedGlobalListing(drive),
    true
  );
  // Folders and files page concurrently as two independent listings.
  assert.deepEqual(
    drive.listQueries().filter((query) => query.startsWith("trashed = false")).sort(),
    [
      `trashed = false and mimeType != '${FOLDER_MIME}'`,
      `trashed = false and mimeType = '${FOLDER_MIME}'`,
    ].sort()
  );
});

test("global fetch pages folders and files concurrently", async () => {
  const items = [folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z")];
  // Enough of each kind to force several pages per listing.
  for (let i = 0; i < 5; i++) {
    items.push(folder(`sub-${i}`, `sub-${i}`, "project", `2026-04-04T10:0${i}:00.000Z`));
    items.push(file(`file-${i}`, `file-${i}.txt`, "project", `2026-04-04T10:1${i}:00.000Z`, `md5-${i}`));
  }

  const drive = createFakeDrive(items, { listDelayMs: 20 });
  const originalList = drive.files.list.bind(drive.files);
  let inFlight = 0;
  let peakInFlight = 0;
  drive.files.list = async (params) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      return await originalList({ ...params, pageSize: 2 });
    } finally {
      inFlight -= 1;
    }
  };

  const remoteState = await getRemoteState(drive, "project", null, {
    estimatedRemoteFiles: 50_000,
  });

  assert.equal(peakInFlight, 2, "folder and file listings should overlap");
  assert.deepEqual(
    remoteState.files.map((item) => item.path).sort(),
    [
      "file-0.txt", "file-1.txt", "file-2.txt", "file-3.txt", "file-4.txt",
      "sub-0", "sub-1", "sub-2", "sub-3", "sub-4",
    ]
  );
});

test("getRemoteState reuses Drive memo and applies incremental changes", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    file("inside", "inside.txt", "project", "2026-04-04T10:02:00.000Z", "inside"),
    folder("outside", "Outside", "real-my-drive-root", "2026-04-04T10:04:00.000Z"),
    file("outside-file", "outside.txt", "outside", "2026-04-04T10:05:00.000Z", "outside"),
  ]);

  const options = { estimatedRemoteFiles: 50_000 };
  const firstState = await getRemoteState(drive, "project", null, options);
  assert.deepEqual(firstState.files.map((item) => item.path), ["inside.txt"]);
  assert.equal(
    performedGlobalListing(drive),
    true
  );

  drive.clearListQueries();
  await drive.files.create({
    requestBody: {
      name: "new.txt",
      parents: ["project"],
    },
    media: { body: Readable.from(["new"]) },
  });

  const secondState = await getRemoteState(drive, "project", null, options);

  assert.deepEqual(
    secondState.files.map((item) => item.path).sort(),
    ["inside.txt", "new.txt"]
  );
  assert.equal(
    performedGlobalListing(drive),
    false
  );
});

test("getRemoteState memo keeps the newest of several edits to one file", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    file("inside", "inside.txt", "project", "2026-04-04T10:02:00.000Z", "inside"),
  ]);
  const options = { estimatedRemoteFiles: 50_000 };

  await getRemoteState(drive, "project", null, options);

  await drive.files.update({
    fileId: "inside",
    media: { body: Readable.from(["second"]) },
  });
  await drive.files.update({
    fileId: "inside",
    media: { body: Readable.from(["third"]) },
  });

  const state = await getRemoteState(drive, "project", null, options);

  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].md5Checksum, md5(Buffer.from("third")));
});

test("getRemoteState memo drops a file edited and then trashed in one window", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    file("inside", "inside.txt", "project", "2026-04-04T10:02:00.000Z", "inside"),
    file("keep", "keep.txt", "project", "2026-04-04T10:03:00.000Z", "keep"),
  ]);
  const options = { estimatedRemoteFiles: 50_000 };

  await getRemoteState(drive, "project", null, options);

  await drive.files.update({
    fileId: "inside",
    media: { body: Readable.from(["edited"]) },
  });
  await drive.files.update({
    fileId: "inside",
    requestBody: { trashed: true },
  });

  const state = await getRemoteState(drive, "project", null, options);

  assert.deepEqual(state.files.map((item) => item.path), ["keep.txt"]);
});

test("getRemoteState memo tracks a new folder chain reported deepest-first", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    file("inside", "inside.txt", "project", "2026-04-04T10:02:00.000Z", "inside"),
  ]);
  const options = { estimatedRemoteFiles: 50_000 };

  await getRemoteState(drive, "project", null, options);

  // Build the chain leaf-first so the change feed reports children before the
  // parents they hang from.
  const leafFile = { id: "chain-file", name: "deep.txt", parents: ["chain-c"] };
  const chain = [
    folder("chain-c", "c", "chain-b", "2026-04-04T11:00:00.000Z"),
    folder("chain-b", "b", "chain-a", "2026-04-04T11:00:01.000Z"),
    folder("chain-a", "a", "project", "2026-04-04T11:00:02.000Z"),
  ];

  const memoChanges = [
    { fileId: leafFile.id, file: { ...leafFile, mimeType: "text/plain", md5Checksum: "deep" } },
    ...chain.map((item) => ({ fileId: item.id, file: item })),
  ];
  drive.changes.list = async () => ({
    data: { changes: structuredClone(memoChanges), newStartPageToken: "999" },
  });

  const state = await getRemoteState(drive, "project", null, options);

  assert.deepEqual(
    state.files.map((item) => item.path).sort(),
    ["a/b/c/deep.txt", "inside.txt"]
  );
});

test("getRemoteState can refresh Drive memo from an authoritative listing", async () => {
  const drive = createFakeDrive([
    folder("project", "Project", "real-my-drive-root", "2026-04-04T10:00:00.000Z"),
    file("inside", "inside.txt", "project", "2026-04-04T10:02:00.000Z", "inside"),
  ]);
  const options = { estimatedRemoteFiles: 50_000 };

  const firstState = await getRemoteState(drive, "project", null, options);
  assert.deepEqual(firstState.files.map((item) => item.path), ["inside.txt"]);

  await drive.files.update({
    fileId: "inside",
    requestBody: { trashed: true },
  });

  drive.clearListQueries();
  const refreshedState = await getRemoteState(drive, "project", null, {
    ...options,
    refreshRemoteMemo: true,
  });

  assert.deepEqual(refreshedState.files, []);
  assert.equal(
    performedGlobalListing(drive),
    true
  );
  assert.equal(
    drive.snapshot().filter((item) => item.name.startsWith(".aethel-remote-memo-")).length,
    1
  );
});

test("executeStaged does not create duplicate folders during concurrent uploads", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "其他", "docs"), { recursive: true });

    const staged = [];
    for (let index = 0; index < 6; index += 1) {
      const relativePath = `其他/docs/file-${index}.txt`;
      await fs.writeFile(path.join(workspaceRoot, relativePath), `file-${index}`);
      staged.push({
        action: "upload",
        path: relativePath,
        localPath: relativePath,
      });
    }

    writeIndex(workspaceRoot, { staged });

    const drive = createFakeDrive([], { listDelayMs: 20 });
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.uploaded, 6);

    const snapshot = drive.snapshot();
    const rootFolders = snapshot.filter(
      (item) =>
        item.mimeType === FOLDER_MIME &&
        !item.trashed &&
        item.name === "其他" &&
        item.parents.includes("root")
    );
    assert.equal(rootFolders.length, 1);

    const docsFolders = snapshot.filter(
      (item) =>
        item.mimeType === FOLDER_MIME &&
        !item.trashed &&
        item.name === "docs" &&
        item.parents.includes(rootFolders[0].id)
    );
    assert.equal(docsFolders.length, 1);

    const queries = drive.listQueries();
    assert.equal(
      queries.filter((query) => query === `'${docsFolders[0].id}' in parents and trashed = false`).length,
      1
    );
    assert.equal(
      queries.filter(
        (query) =>
          query.includes(`'${docsFolders[0].id}' in parents`) &&
          /name = 'file-\d+\.txt'/.test(query)
      ).length,
      0
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged downloads staged files without an extra metadata request", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-fast-download-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    const content = Buffer.from("downloaded content");
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "download",
          path: "fast.txt",
          localPath: "fast.txt",
          fileId: "remote-fast",
          remotePath: "fast.txt",
          remoteMimeType: "text/plain",
          remoteMd5Checksum: md5(content),
        },
      ],
    });

    let metadataGets = 0;
    let mediaGets = 0;
    const result = await executeStaged({
      files: {
        async get(params) {
          if (params.alt === "media") {
            mediaGets += 1;
            return { data: Readable.from([content]) };
          }
          metadataGets += 1;
          throw new Error("metadata should already be staged");
        },
      },
    }, workspaceRoot);

    assert.equal(result.downloaded, 1);
    assert.equal(metadataGets, 0);
    assert.equal(mediaGets, 1);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "fast.txt"), "utf8"), "downloaded content");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged starts the largest staged transfer first", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-schedule-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    const bodies = new Map([
      ["remote-small-1", Buffer.from("a")],
      ["remote-small-2", Buffer.from("b")],
      ["remote-huge", Buffer.from("c".repeat(4096))],
    ]);

    // The big file is staged last, where a FIFO pool would leave it running
    // alone after everything else drained.
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "download",
          path: "small-1.txt",
          localPath: "small-1.txt",
          fileId: "remote-small-1",
          remoteMimeType: "text/plain",
          remoteMd5Checksum: md5(bodies.get("remote-small-1")),
          remoteSize: 1,
        },
        {
          action: "download",
          path: "small-2.txt",
          localPath: "small-2.txt",
          fileId: "remote-small-2",
          remoteMimeType: "text/plain",
          remoteMd5Checksum: md5(bodies.get("remote-small-2")),
          remoteSize: 1,
        },
        {
          action: "download",
          path: "huge.bin",
          localPath: "huge.bin",
          fileId: "remote-huge",
          remoteMimeType: "text/plain",
          remoteMd5Checksum: md5(bodies.get("remote-huge")),
          remoteSize: 4096,
        },
      ],
    });

    const started = [];
    const result = await executeStaged(
      {
        files: {
          async get(params) {
            started.push(params.fileId);
            return { data: Readable.from([bodies.get(params.fileId)]) };
          },
        },
      },
      workspaceRoot
    );

    assert.equal(result.downloaded, 3);
    assert.equal(started[0], "remote-huge");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged reuses snapshot metadata for staged downloads", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-fast-download-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    const content = Buffer.from("downloaded from snapshot metadata");
    writeSnapshot(workspaceRoot, {
      timestamp: "2026-06-21T00:00:00.000Z",
      message: "snapshot",
      files: {
        "remote-fast": {
          path: "fast.txt",
          mimeType: "text/plain",
          md5Checksum: md5(content),
          modifiedTime: "2026-06-21T00:00:00.000Z",
        },
      },
      localFiles: {},
    });
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "download",
          path: "fast.txt",
          localPath: "fast.txt",
          fileId: "remote-fast",
          remotePath: "fast.txt",
        },
      ],
    });

    let metadataGets = 0;
    let mediaGets = 0;
    const result = await executeStaged({
      files: {
        async get(params) {
          if (params.alt === "media") {
            mediaGets += 1;
            return { data: Readable.from([content]) };
          }
          metadataGets += 1;
          throw new Error("metadata should be loaded from snapshot");
        },
      },
    }, workspaceRoot);

    assert.equal(result.downloaded, 1);
    assert.equal(metadataGets, 0);
    assert.equal(mediaGets, 1);
    assert.equal(
      await fs.readFile(path.join(workspaceRoot, "fast.txt"), "utf8"),
      "downloaded from snapshot metadata"
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged resolves legacy delete_remote entries from snapshot path", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    writeSnapshot(workspaceRoot, {
      timestamp: new Date().toISOString(),
      message: "baseline",
      files: {
        "remote-1": {
          id: "remote-1",
          name: "Content.md",
          path: "Content.md",
          localPath: "Content.md",
          md5Checksum: "content",
        },
      },
      localFiles: {},
    });
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_remote",
          path: "Content.md",
          localPath: "Content.md",
        },
      ],
    });

    const drive = createFakeDrive([
      file("remote-1", "Content.md", "root", "2026-04-04T10:34:00.000Z", "content"),
    ]);
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.deletedRemote, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(drive.snapshot().find((item) => item.id === "remote-1").trashed, true);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged resolves delete_remote entries from current Drive path", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    writeSnapshot(workspaceRoot, {
      timestamp: new Date().toISOString(),
      message: "baseline",
      files: {},
      localFiles: {},
    });
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_remote",
          path: "docs/archive",
          localPath: "docs/archive",
        },
      ],
    });

    const drive = createFakeDrive([
      folder("folder-docs", "docs", "root", "2026-04-04T10:33:00.000Z"),
      folder("folder-archive", "archive", "folder-docs", "2026-04-04T10:34:00.000Z"),
      file("remote-child", "notes.txt", "folder-archive", "2026-04-04T10:35:00.000Z", "child"),
    ]);
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.deletedRemote, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(drive.snapshot().find((item) => item.id === "folder-archive").trashed, true);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged treats missing path-only delete_remote entries as already deleted", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    writeSnapshot(workspaceRoot, {
      timestamp: new Date().toISOString(),
      message: "baseline",
      files: {},
      localFiles: {},
    });
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_remote",
          path: "docs/archive/notes.txt",
          localPath: "docs/archive/notes.txt",
        },
      ],
    });

    const drive = createFakeDrive([
      folder("folder-docs", "docs", "root", "2026-04-04T10:33:00.000Z"),
    ]);
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.deletedRemote, 0);
    assert.deepEqual(result.errors, []);
    assert.equal(readIndex(workspaceRoot).staged.length, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged preserves remote content when a staged upload source disappears", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-stale-upload-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "upload",
          path: "deleted-locally.md",
          localPath: "deleted-locally.md",
          remotePath: "deleted-locally.md",
          fileId: "remote-file",
        },
      ],
    });

    const drive = createFakeDrive([
      file("remote-file", "deleted-locally.md", "root", "2026-04-04T10:34:00.000Z", "old"),
    ]);
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.errors.length, 1);
    assert.equal(result.deletedRemote, 0);
    assert.equal(result.uploaded, 0);
    assert.equal(readIndex(workspaceRoot).staged.length, 1);
    assert.equal(drive.snapshot().find((item) => item.id === "remote-file").trashed, false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged retains a missing staged upload for replanning", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-stale-new-upload-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "upload",
          path: "new-then-deleted.md",
          localPath: "new-then-deleted.md",
        },
      ],
    });

    const drive = createFakeDrive([]);
    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.errors.length, 1);
    assert.equal(result.total, 0);
    assert.equal(readIndex(workspaceRoot).staged.length, 1);
    assert.equal(drive.snapshot().length, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged keeps non-empty local folder deletions staged on failure", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "keep.txt"), "local");

    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_local",
          path: "docs",
          localPath: "docs",
          isFolder: true,
        },
      ],
    });

    const result = await executeStaged({ files: {} }, workspaceRoot);

    assert.equal(result.deletedLocal, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /delete_local docs:/);
    await fs.stat(path.join(workspaceRoot, "docs", "keep.txt"));
    assert.equal(readIndex(workspaceRoot).staged.length, 1);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged recursively deletes local folder trees deleted on Drive", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "nested", "gone.txt"), "remote removed");

    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_local",
          path: "docs",
          localPath: "docs",
          isFolder: true,
          recursiveLocalDelete: true,
        },
      ],
    });

    const result = await executeStaged({ files: {} }, workspaceRoot);

    assert.equal(result.deletedLocal, 1);
    assert.deepEqual(result.errors, []);
    await assert.rejects(fs.stat(path.join(workspaceRoot, "docs")), { code: "ENOENT" });
    assert.equal(readIndex(workspaceRoot).staged.length, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged deletes an empty local directory even when folder metadata is missing", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });

    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_local",
          path: "docs",
          localPath: "docs",
        },
      ],
    });

    const result = await executeStaged({ files: {} }, workspaceRoot);

    assert.equal(result.deletedLocal, 1);
    assert.deepEqual(result.errors, []);
    await assert.rejects(fs.stat(path.join(workspaceRoot, "docs")), { code: "ENOENT" });
    assert.equal(readIndex(workspaceRoot).staged.length, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged cleans empty parent folders after file-only local deletions", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "a.txt"), "a");
    await fs.writeFile(path.join(workspaceRoot, "docs", "nested", "b.txt"), "b");

    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "delete_local",
          path: "docs/a.txt",
          localPath: "docs/a.txt",
        },
        {
          action: "delete_local",
          path: "docs/nested/b.txt",
          localPath: "docs/nested/b.txt",
        },
      ],
    });

    const result = await executeStaged({ files: {} }, workspaceRoot);

    assert.equal(result.deletedLocal, 2);
    assert.deepEqual(result.errors, []);
    await assert.rejects(fs.stat(path.join(workspaceRoot, "docs")), { code: "ENOENT" });
    assert.equal(readIndex(workspaceRoot).staged.length, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

// A remote delete or move can leave the old parent directories empty. Drive
// keeps empty folders, so only the parents Drive no longer has may be pruned;
// `retainDirectory` names the deepest ancestor Drive still has ("" for none).

async function runStagedLocalOps(t, directories, files, staged) {
  const workspaceRoot = createTempDirectory(t, "aethel-prune-");
  initWorkspace(workspaceRoot, null, "My Drive");
  for (const directory of directories) {
    await fs.mkdir(path.join(workspaceRoot, directory), { recursive: true });
  }
  for (const filePath of files) {
    await fs.writeFile(path.join(workspaceRoot, filePath), "x");
  }
  writeIndex(workspaceRoot, { staged });
  const result = await executeStaged({ files: {} }, workspaceRoot);
  assert.deepEqual(result.errors, []);
  const exists = (relativePath) => fsNative.existsSync(path.join(workspaceRoot, relativePath));
  return { result, exists, workspaceRoot };
}

test("executeStaged prunes the parents of a deleted folder that Drive no longer has", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], [], [
    { action: "delete_local", path: "docs/sub", localPath: "docs/sub", isFolder: true, retainDirectory: "" },
  ]);

  assert.equal(exists("docs/sub"), false);
  assert.equal(exists("docs"), false);
});

test("executeStaged stops pruning at the ancestor Drive still has", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/a/b"], [], [
    { action: "delete_local", path: "docs/a/b", localPath: "docs/a/b", isFolder: true, retainDirectory: "docs" },
  ]);

  assert.equal(exists("docs/a"), false);
  assert.equal(exists("docs"), true);
});

test("executeStaged never prunes a parent that still holds local content", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], ["docs/mine.txt"], [
    { action: "delete_local", path: "docs/sub", localPath: "docs/sub", isFolder: true, retainDirectory: "" },
  ]);

  assert.equal(exists("docs/mine.txt"), true);
});

test("executeStaged keeps the emptied folder Drive still has after its last file is deleted", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], ["docs/sub/x.txt"], [
    { action: "delete_local", path: "docs/sub/x.txt", localPath: "docs/sub/x.txt", retainDirectory: "docs/sub" },
  ]);

  assert.equal(exists("docs/sub/x.txt"), false);
  assert.equal(exists("docs/sub"), true);
});

test("executeStaged still prunes every empty parent of a deleted file when no ancestor is retained", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], ["docs/sub/x.txt"], [
    { action: "delete_local", path: "docs/sub/x.txt", localPath: "docs/sub/x.txt", retainDirectory: "" },
  ]);

  assert.equal(exists("docs"), false);
});

test("executeStaged leaves the parents of a folder delete alone when the entry names no retained ancestor", async (t) => {
  // Entries staged before the hint existed keep their previous behaviour.
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], [], [
    { action: "delete_local", path: "docs/sub", localPath: "docs/sub", isFolder: true },
  ]);

  assert.equal(exists("docs/sub"), false);
  assert.equal(exists("docs"), true);
});

test("executeStaged prunes the old parents of a moved folder that Drive no longer has", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], ["docs/sub/x.txt"], [
    { action: "move_local", path: "archive/sub", localPath: "archive/sub", sourcePath: "docs/sub", retainDirectory: "" },
  ]);

  assert.equal(exists("archive/sub/x.txt"), true);
  assert.equal(exists("docs"), false);
});

test("executeStaged keeps the old parent of a moved folder when Drive still has it", async (t) => {
  const { exists } = await runStagedLocalOps(t, ["docs/sub"], ["docs/sub/x.txt"], [
    { action: "move_local", path: "archive/sub", localPath: "archive/sub", sourcePath: "docs/sub", retainDirectory: "docs" },
  ]);

  assert.equal(exists("archive/sub/x.txt"), true);
  assert.equal(exists("docs"), true);
});

// A recursive delete removes every local file under the folder. It is checked
// against the baseline right before it runs, because staged entries outlive the
// plan that made them and files appear in between.

async function stageRecursiveFolderDelete(t, { baselineFiles, localFiles, ignore = null }) {
  const workspaceRoot = createTempDirectory(t, "aethel-recursive-");
  initWorkspace(workspaceRoot, null, "My Drive");
  const files = {};
  const baselineLocal = {};
  for (const [relativePath, content] of Object.entries(baselineFiles)) {
    files[`id:${relativePath}`] = {
      id: `id:${relativePath}`,
      path: relativePath,
      localPath: relativePath,
      md5Checksum: md5(Buffer.from(content)),
    };
    baselineLocal[relativePath] = { localPath: relativePath, md5: md5(Buffer.from(content)) };
  }
  writeSnapshot(workspaceRoot, {
    timestamp: "2026-10-01T00:00:00.000Z",
    message: "baseline",
    files,
    localFiles: baselineLocal,
  });
  if (ignore) await fs.writeFile(path.join(workspaceRoot, ".aethelignore"), ignore);
  for (const [relativePath, content] of Object.entries(localFiles)) {
    const absolutePath = path.join(workspaceRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  writeIndex(workspaceRoot, {
    staged: [{
      action: "delete_local",
      path: "docs",
      localPath: "docs",
      isFolder: true,
      recursiveLocalDelete: true,
    }],
  });
  const result = await executeStaged({ files: {} }, workspaceRoot);
  const exists = (relativePath) => fsNative.existsSync(path.join(workspaceRoot, relativePath));
  return { result, exists, workspaceRoot };
}

test("executeStaged deletes a folder tree whose local files all match the baseline", async (t) => {
  const { result, exists, workspaceRoot } = await stageRecursiveFolderDelete(t, {
    baselineFiles: { "docs/a.txt": "a", "docs/sub/b.txt": "b" },
    localFiles: { "docs/a.txt": "a", "docs/sub/b.txt": "b" },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(exists("docs"), false);
  assert.equal(readIndex(workspaceRoot).staged.length, 0);
});

test("executeStaged refuses a recursive delete that would destroy a local file Drive never had", async (t) => {
  const { result, exists, workspaceRoot } = await stageRecursiveFolderDelete(t, {
    baselineFiles: { "docs/a.txt": "a" },
    localFiles: { "docs/a.txt": "a", "docs/new.txt": "unsynced work" },
  });

  assert.equal(result.deletedLocal, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to delete docs.*docs\/new\.txt/);
  assert.equal(exists("docs/new.txt"), true);
  assert.equal(exists("docs/a.txt"), true, "nothing is removed when the folder is refused");
  assert.equal(readIndex(workspaceRoot).staged.length, 1, "the refused entry stays staged");
});

test("executeStaged refuses a recursive delete that would destroy a local edit", async (t) => {
  const { result, exists } = await stageRecursiveFolderDelete(t, {
    baselineFiles: { "docs/a.txt": "a" },
    localFiles: { "docs/a.txt": "edited since the baseline" },
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to delete docs.*docs\/a\.txt/);
  assert.equal(exists("docs/a.txt"), true);
});

test("executeStaged refuses a file that is in the local baseline but was never on Drive", async (t) => {
  // The baseline records scanned files whether or not they uploaded, so it is
  // the Drive-side record that says Drive has the file.
  const workspaceRoot = createTempDirectory(t, "aethel-recursive-");
  initWorkspace(workspaceRoot, null, "My Drive");
  writeSnapshot(workspaceRoot, {
    timestamp: "2026-10-01T00:00:00.000Z",
    message: "baseline",
    files: {
      a: { id: "a", path: "docs/a.txt", localPath: "docs/a.txt", md5Checksum: md5(Buffer.from("a")) },
    },
    localFiles: {
      "docs/a.txt": { localPath: "docs/a.txt", md5: md5(Buffer.from("a")) },
      "docs/draft.txt": { localPath: "docs/draft.txt", md5: md5(Buffer.from("draft")) },
    },
  });
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "docs", "a.txt"), "a");
  await fs.writeFile(path.join(workspaceRoot, "docs", "draft.txt"), "draft");
  writeIndex(workspaceRoot, {
    staged: [{ action: "delete_local", path: "docs", localPath: "docs", isFolder: true, recursiveLocalDelete: true }],
  });

  const result = await executeStaged({ files: {} }, workspaceRoot);

  assert.match(result.errors[0], /docs\/draft\.txt/);
  assert.equal(fsNative.existsSync(path.join(workspaceRoot, "docs", "draft.txt")), true);
});

test("executeStaged lists only a few of many files at risk", async (t) => {
  const localFiles = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`docs/new-${index}.txt`, "work"])
  );
  const { result } = await stageRecursiveFolderDelete(t, {
    baselineFiles: { "docs/a.txt": "a" },
    localFiles: { "docs/a.txt": "a", ...localFiles },
  });

  assert.match(result.errors[0], /\(\+3 more\)/);
});

test("executeStaged still deletes ignored files together with the folder", async (t) => {
  const { result, exists } = await stageRecursiveFolderDelete(t, {
    baselineFiles: { "docs/a.txt": "a" },
    localFiles: { "docs/a.txt": "a", "docs/debug.log": "ignored noise" },
    ignore: "*.log\n",
  });

  assert.deepEqual(result.errors, []);
  assert.equal(exists("docs"), false);
});

// The same holds for deleting a single file: it may only go if Drive has it and
// it is unchanged since the last sync.

async function runStagedFileDeletes(t, {
  baselineFiles,
  driveKnows = Object.keys(baselineFiles),
  statInBaseline = false,
  localFiles,
  staged,
}) {
  const workspaceRoot = createTempDirectory(t, "aethel-file-delete-");
  initWorkspace(workspaceRoot, null, "My Drive");
  for (const [relativePath, content] of Object.entries(localFiles)) {
    const absolutePath = path.join(workspaceRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  const files = {};
  const baselineLocal = {};
  for (const [relativePath, content] of Object.entries(baselineFiles)) {
    const digest = md5(Buffer.from(content));
    baselineLocal[relativePath] = { localPath: relativePath, md5: digest };
    if (statInBaseline) {
      const stat = await fs.stat(path.join(workspaceRoot, ...relativePath.split("/")));
      Object.assign(baselineLocal[relativePath], {
        size: stat.size,
        modifiedTime: new Date(stat.mtimeMs).toISOString(),
      });
    }
    if (driveKnows.includes(relativePath)) {
      files[`id:${relativePath}`] = {
        id: `id:${relativePath}`,
        path: relativePath,
        localPath: relativePath,
        md5Checksum: digest,
      };
    }
  }
  writeSnapshot(workspaceRoot, {
    timestamp: "2026-10-01T00:00:00.000Z",
    message: "baseline",
    files,
    localFiles: baselineLocal,
  });
  writeIndex(workspaceRoot, { staged });
  const result = await executeStaged({ files: {} }, workspaceRoot);
  const exists = (relativePath) => fsNative.existsSync(path.join(workspaceRoot, relativePath));
  const read = (relativePath) => fsNative.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
  return { result, exists, read, workspaceRoot };
}

const deleteFile = (relativePath, extra = {}) => ({
  action: "delete_local",
  path: relativePath,
  localPath: relativePath,
  ...extra,
});

test("executeStaged deletes a file that is unchanged since the last sync", async (t) => {
  const { result, exists, workspaceRoot } = await runStagedFileDeletes(t, {
    baselineFiles: { "docs/a.txt": "a" },
    localFiles: { "docs/a.txt": "a" },
    staged: [deleteFile("docs/a.txt")],
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.deletedLocal, 1);
  assert.equal(exists("docs/a.txt"), false);
  assert.equal(readIndex(workspaceRoot).staged.length, 0);
});

test("executeStaged refuses to delete a file edited since the last sync", async (t) => {
  const { result, exists, read, workspaceRoot } = await runStagedFileDeletes(t, {
    baselineFiles: { "docs/a.txt": "a" },
    localFiles: { "docs/a.txt": "an edit made after planning" },
    staged: [deleteFile("docs/a.txt")],
  });

  assert.equal(result.deletedLocal, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to delete docs\/a\.txt: it changed locally/);
  assert.equal(exists("docs/a.txt"), true);
  assert.equal(read("docs/a.txt"), "an edit made after planning");
  assert.equal(readIndex(workspaceRoot).staged.length, 1, "the refused entry stays staged");
});

test("executeStaged catches an edit that leaves the file the same size", async (t) => {
  const { result, read } = await runStagedFileDeletes(t, {
    baselineFiles: { "a.txt": "a" },
    localFiles: { "a.txt": "b" },
    staged: [deleteFile("a.txt")],
  });

  assert.match(result.errors[0], /changed locally/);
  assert.equal(read("a.txt"), "b");
});

test("executeStaged refuses to delete a file Drive has no record of", async (t) => {
  const { result, exists } = await runStagedFileDeletes(t, {
    baselineFiles: {},
    localFiles: { "docs/mine.txt": "never uploaded" },
    staged: [deleteFile("docs/mine.txt")],
  });

  assert.match(result.errors[0], /Refusing to delete docs\/mine\.txt: Drive has no record of this file/);
  assert.equal(exists("docs/mine.txt"), true);
});

test("executeStaged refuses a file in the local baseline that never reached Drive", async (t) => {
  // The baseline records scanned files whether or not they uploaded.
  const { result, exists } = await runStagedFileDeletes(t, {
    baselineFiles: { "draft.txt": "draft" },
    driveKnows: [],
    localFiles: { "draft.txt": "draft" },
    staged: [deleteFile("draft.txt")],
  });

  assert.match(result.errors[0], /Drive has no record of this file/);
  assert.equal(exists("draft.txt"), true);
});

test("executeStaged deletes the files it may and keeps the edited one next to them", async (t) => {
  const { result, exists, read } = await runStagedFileDeletes(t, {
    baselineFiles: { "docs/a.txt": "a", "docs/b.txt": "b" },
    localFiles: { "docs/a.txt": "a", "docs/b.txt": "edited" },
    staged: [deleteFile("docs/a.txt"), deleteFile("docs/b.txt")],
  });

  assert.equal(result.deletedLocal, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(exists("docs/a.txt"), false);
  assert.equal(read("docs/b.txt"), "edited");
  assert.equal(exists("docs"), true, "the folder still holds the refused file");
});

test("executeStaged judges a deletion by the path the plan named after its folder moved", async (t) => {
  // The file is deleted at archive/old.txt, but the baseline knows it as docs/old.txt.
  const { result, exists } = await runStagedFileDeletes(t, {
    baselineFiles: { "docs/old.txt": "old" },
    localFiles: { "docs/old.txt": "old" },
    staged: [
      { action: "move_local", path: "archive", localPath: "archive", sourcePath: "docs" },
      deleteFile("docs/old.txt"),
    ],
  });

  assert.deepEqual(result.errors, []);
  assert.equal(exists("archive/old.txt"), false);
});

test("executeStaged does not re-read a file whose size and modification time match the baseline", async (t) => {
  // The scanner treats such a file as unchanged without hashing it; so does the guard.
  const { result, exists } = await runStagedFileDeletes(t, {
    baselineFiles: { "a.txt": "a" },
    statInBaseline: true,
    localFiles: { "a.txt": "b" }, // different bytes, same size; the baseline md5 is not consulted
    staged: [deleteFile("a.txt")],
  });

  assert.deepEqual(result.errors, []);
  assert.equal(exists("a.txt"), false);
});

test("executeStaged treats a file that vanished before deletion as already deleted", async (t) => {
  const { result } = await runStagedFileDeletes(t, {
    baselineFiles: { "a.txt": "a" },
    localFiles: { "other.txt": "x" },
    staged: [deleteFile("a.txt")],
  });

  assert.deepEqual(result.errors, []);
});

// A download replaces the local file at its path. That may only cost the user
// nothing: the file already holds what Drive has, or has not changed since the
// last sync — or they chose to overwrite it, and then it must still be as it
// was when they chose.

async function runStagedDownload(t, {
  localFiles = {},
  baselineFiles = {},
  entry,
  remoteContent = "remote version",
  beforeTransfer = null,
}) {
  const workspaceRoot = createTempDirectory(t, "aethel-download-guard-");
  initWorkspace(workspaceRoot, null, "My Drive");
  for (const [relativePath, content] of Object.entries(localFiles)) {
    const absolutePath = path.join(workspaceRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
  const files = {};
  const baselineLocal = {};
  for (const [relativePath, spec] of Object.entries(baselineFiles)) {
    const digest = md5(Buffer.from(spec.content));
    files[spec.id] = { id: spec.id, path: relativePath, localPath: spec.localPath || relativePath, md5Checksum: digest };
    baselineLocal[spec.localPath || relativePath] = { localPath: spec.localPath || relativePath, md5: digest };
  }
  writeSnapshot(workspaceRoot, {
    timestamp: "2026-10-01T00:00:00.000Z",
    message: "baseline",
    files,
    localFiles: baselineLocal,
  });
  const body = Buffer.from(remoteContent);
  writeIndex(workspaceRoot, {
    staged: [{
      action: "download",
      localPath: entry.path,
      remotePath: entry.path,
      remoteMimeType: "text/plain",
      remoteMd5Checksum: md5(body),
      ...entry,
    }],
  });
  const drive = {
    files: {
      async get(params) {
        if (params.alt !== "media") throw new Error("metadata should already be staged");
        await beforeTransfer?.(workspaceRoot);
        return { data: Readable.from([body]) };
      },
    },
  };
  const result = await executeStaged(drive, workspaceRoot);
  const read = (relativePath) => fsNative.readFileSync(path.join(workspaceRoot, ...relativePath.split("/")), "utf8");
  const leftovers = fsNative.readdirSync(workspaceRoot).filter((name) => name.startsWith(".aethel-download-"));
  return { result, read, leftovers, workspaceRoot };
}

test("executeStaged replaces a file that is unchanged since the last sync", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "synced version" },
    baselineFiles: { "a.txt": { id: "id-a", content: "synced version" } },
    entry: { path: "a.txt", fileId: "id-a" },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(read("a.txt"), "remote version");
});

test("executeStaged refuses to replace a file edited since the last sync", async (t) => {
  const { result, read, leftovers, workspaceRoot } = await runStagedDownload(t, {
    localFiles: { "a.txt": "my unsynced edit" },
    baselineFiles: { "a.txt": { id: "id-a", content: "synced version" } },
    entry: { path: "a.txt", fileId: "id-a" },
  });

  assert.equal(result.downloaded, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to overwrite a\.txt: it changed locally since the last sync/);
  assert.equal(read("a.txt"), "my unsynced edit");
  assert.deepEqual(leftovers, [], "no half-written download is left behind");
  assert.equal(readIndex(workspaceRoot).staged.length, 1, "the refused entry stays staged");
});

test("executeStaged refuses to replace a different local file Drive has not synced", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "a file of my own" },
    entry: { path: "a.txt", fileId: "id-a" },
  });

  assert.match(result.errors[0], /a different local file is already there that Drive has not synced/);
  assert.equal(read("a.txt"), "a file of my own");
});

test("executeStaged leaves a file that already holds the Drive version alone", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "remote version" },
    entry: { path: "a.txt", fileId: "id-a" },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(read("a.txt"), "remote version");
});

test("executeStaged protects a file edited while its replacement downloads", async (t) => {
  const { result, read, leftovers } = await runStagedDownload(t, {
    localFiles: { "a.txt": "synced version" },
    baselineFiles: { "a.txt": { id: "id-a", content: "synced version" } },
    entry: { path: "a.txt", fileId: "id-a" },
    // The file is as synced when the download starts and edited before it ends.
    beforeTransfer: (root) => fs.writeFile(path.join(root, "a.txt"), "edited mid-transfer"),
  });

  assert.match(result.errors[0], /Refusing to overwrite a\.txt/);
  assert.equal(read("a.txt"), "edited mid-transfer");
  assert.deepEqual(leftovers, []);
});

test("executeStaged recognises a file Drive replaced under a new ID at the same path", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "synced version" },
    baselineFiles: { "a.txt": { id: "old-id", content: "synced version" } },
    entry: { path: "a.txt", fileId: "new-id" },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(read("a.txt"), "remote version");
});

test("executeStaged finds the baseline of a file whose folder was renamed locally", async (t) => {
  // The file now lives at docs2/a.txt; the baseline knows it as docs/a.txt.
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "docs2/a.txt": "synced version" },
    baselineFiles: { "docs/a.txt": { id: "id-a", content: "synced version" } },
    entry: { path: "docs/a.txt", localPath: "docs2/a.txt", fileId: "id-a" },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(read("docs2/a.txt"), "remote version");
});

test("executeStaged replaces a file the user chose to overwrite, edits and all", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "edit made before choosing" },
    baselineFiles: { "a.txt": { id: "id-a", content: "synced version" } },
    entry: {
      path: "a.txt",
      fileId: "id-a",
      overwriteLocal: true,
      localMd5: md5(Buffer.from("edit made before choosing")),
    },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(read("a.txt"), "remote version");
});

test("executeStaged refuses an overwrite when the file was edited after the user chose it", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "edit made after choosing" },
    entry: {
      path: "a.txt",
      fileId: "id-a",
      overwriteLocal: true,
      localMd5: md5(Buffer.from("the state they chose against")),
    },
  });

  assert.match(result.errors[0], /Refusing to overwrite a\.txt: it was edited after you chose/);
  assert.equal(read("a.txt"), "edit made after choosing");
});

test("executeStaged overwrites without a recorded state when the user chose to", async (t) => {
  const { result, read } = await runStagedDownload(t, {
    localFiles: { "a.txt": "whatever is there" },
    entry: { path: "a.txt", fileId: "id-a", overwriteLocal: true },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(read("a.txt"), "remote version");
});

test("executeStaged does not guard a Google Workspace export, which is a derived file", async (t) => {
  const workspaceRoot = createTempDirectory(t, "aethel-export-");
  initWorkspace(workspaceRoot, null, "My Drive");
  await fs.writeFile(path.join(workspaceRoot, "plan.docx"), "previous export");
  writeSnapshot(workspaceRoot, {
    timestamp: "2026-10-01T00:00:00.000Z",
    message: "baseline",
    files: {},
    localFiles: {},
  });
  writeIndex(workspaceRoot, {
    staged: [{
      action: "download",
      path: "plan",
      localPath: "plan",
      fileId: "doc-1",
      remotePath: "plan",
      remoteMimeType: "application/vnd.google-apps.document",
    }],
  });
  const result = await executeStaged({
    files: { async export() { return { data: Readable.from(["new export"]) }; } },
  }, workspaceRoot);

  assert.deepEqual(result.errors, []);
  assert.equal(fsNative.readFileSync(path.join(workspaceRoot, "plan.docx"), "utf8"), "new export");
});

test("downloadFile rejects unsupported Google Workspace files before media download", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-download-"));

  try {
    const localPath = path.join(workspaceRoot, "workspace-doc");
    const drive = {
      files: {
        async get() {
          throw new Error("alt media should not be called for Google Workspace files");
        },
        async export() {
          throw new Error("unsupported type should not be exported");
        },
      },
    };

    await assert.rejects(
      downloadFile(
        drive,
        {
          id: "workspace-file",
          name: "workspace-doc",
          mimeType: "application/vnd.google-apps.script",
        },
        localPath
      ),
      /Cannot download Google Workspace file 'workspace-doc'/
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("downloadFile restarts a transfer that dies mid-stream", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-download-"));

  try {
    const localPath = path.join(workspaceRoot, "report.md");
    const contents = "the full body of the file";
    let attempts = 0;

    const drive = {
      files: {
        async get({ alt }) {
          assert.equal(alt, "media");
          attempts += 1;
          if (attempts === 1) {
            const stream = new Readable({ read() {} });
            stream.push(contents.slice(0, 5));
            setImmediate(() => {
              stream.destroy(
                Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
              );
            });
            return { data: stream };
          }
          return { data: Readable.from([contents]) };
        },
      },
    };

    await downloadFile(
      drive,
      {
        id: "remote-1",
        name: "report.md",
        mimeType: "text/markdown",
        md5Checksum: md5(Buffer.from(contents)),
      },
      localPath
    );

    assert.equal(attempts, 2);
    assert.equal(await fs.readFile(localPath, "utf8"), contents);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("downloadFile leaves no file behind when integrity never checks out", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-download-"));

  try {
    const localPath = path.join(workspaceRoot, "report.md");
    let attempts = 0;

    const drive = {
      files: {
        async get() {
          attempts += 1;
          return { data: Readable.from(["corrupted"]) };
        },
      },
    };

    await assert.rejects(
      downloadFile(
        drive,
        {
          id: "remote-1",
          name: "report.md",
          mimeType: "text/markdown",
          md5Checksum: md5(Buffer.from("the real body")),
        },
        localPath
      ),
      /Integrity check failed for report\.md/
    );

    assert.equal(attempts, 3);
    assert.equal(fsNative.existsSync(localPath), false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("withDriveRetry rebuilds the upload body on every attempt", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    const localPath = path.join(workspaceRoot, "report.md");
    await fs.writeFile(localPath, "new content");

    const fake = createFakeDrive([
      file("remote-1", "report.md", "root", "2026-04-04T10:34:00.000Z", "old-1"),
    ]);
    const realUpdate = fake.files.update.bind(fake.files);
    let updateCalls = 0;
    fake.files.update = async (params) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        // Drive consumes the request body before answering, so a retry that
        // reuses this stream has nothing left to send.
        for await (const _chunk of params.media.body) {
          // discard
        }
        const err = new Error("backend error");
        err.code = 503;
        throw err;
      }
      return realUpdate(params);
    };

    const drive = withDriveRetry(fake);
    const result = await uploadFile(drive, localPath, "report.md", {
      parentId: "root",
      existingId: "remote-1",
    });

    assert.equal(updateCalls, 2);
    // A retry that replayed the consumed stream would upload an empty body.
    assert.equal(result.md5Checksum, md5(Buffer.from("new content")));
    assert.equal(
      fake.snapshot().find((item) => item.id === "remote-1")._body,
      "new content"
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("withDriveRetry backs off on transient changes.list failures", async () => {
  const fake = createFakeDrive([
    file("remote-1", "report.md", "root", "2026-04-04T10:34:00.000Z", "md5-1"),
  ]);
  const realList = fake.changes.list.bind(fake.changes);
  let listCalls = 0;
  fake.changes.list = async (params) => {
    listCalls += 1;
    if (listCalls === 1) {
      const err = new Error("rate limit exceeded");
      err.code = 429;
      throw err;
    }
    return realList(params);
  };

  const drive = withDriveRetry(fake);
  const response = await drive.changes.list({ pageToken: "0" });

  assert.equal(listCalls, 2);
  assert.equal(response.data.changes.length, 0);
});

test("uploadFile updates an existing same-name file and trashes duplicates", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    const localPath = path.join(workspaceRoot, "report.md");
    await fs.writeFile(localPath, "new content");

    const drive = createFakeDrive([
      file("remote-1", "report.md", "root", "2026-04-04T10:34:00.000Z", "old-1"),
      file("remote-2", "report.md", "root", "2026-04-04T10:35:00.000Z", "old-2"),
    ]);

    const result = await uploadFile(drive, localPath, "report.md", {
      parentId: "root",
      cleanupDuplicates: true,
    });

    const snapshot = drive.snapshot();
    const activeReports = snapshot.filter((item) => item.name === "report.md" && !item.trashed);
    const trashedReports = snapshot.filter((item) => item.name === "report.md" && item.trashed);

    assert.equal(result.id, "remote-1");
    assert.equal(result.md5Checksum, md5(Buffer.from("new content")));
    assert.equal(activeReports.length, 1);
    assert.equal(activeReports[0].id, "remote-1");
    assert.deepEqual(trashedReports.map((item) => item.id), ["remote-2"]);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("uploadFile does not replace unrelated same-name files when a tracked ID disappears", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    const localPath = path.join(workspaceRoot, "report.md");
    await fs.writeFile(localPath, "new content");

    const drive = createFakeDrive([
      file("remote-1", "report.md", "root", "2026-04-04T10:34:00.000Z", "old-1"),
      file("remote-2", "report.md", "root", "2026-04-04T10:35:00.000Z", "old-2"),
    ]);

    await assert.rejects(uploadFile(drive, localPath, "report.md", {
      parentId: "root",
      existingId: "stale-id",
      cleanupDuplicates: true,
    }), { code: "REMOTE_CHANGED" });
    const active = drive.snapshot().filter(item => !item.trashed);
    assert.deepEqual(active.map(item => item.md5Checksum).sort(), ["old-1", "old-2"]);

  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("uploadLocalEntry caches sibling lookups within the same target folder", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    const bundlePath = path.join(workspaceRoot, "bundle");
    await fs.mkdir(bundlePath, { recursive: true });
    await Promise.all(
      ["a.txt", "b.txt", "c.txt"].map((name) =>
        fs.writeFile(path.join(bundlePath, name), name)
      )
    );

    const drive = createFakeDrive([]);
    const result = await uploadLocalEntry(drive, bundlePath, "root");

    assert.equal(result.uploadedFiles, 3);
    const bundleFolder = drive
      .snapshot()
      .find(
        (item) =>
          item.mimeType === FOLDER_MIME &&
          !item.trashed &&
          item.name === "bundle" &&
          item.parents.includes("root")
      );
    assert.ok(bundleFolder);

    const queries = drive.listQueries();
    assert.equal(
      queries.filter((query) => query === `'${bundleFolder.id}' in parents and trashed = false`).length,
      1
    );
    assert.equal(
      queries.filter((query) => query.includes(`'${bundleFolder.id}' in parents`) && query.includes("name =")).length,
      0
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("uploadFile reports the md5 of the bytes it actually sent", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    const localPath = path.join(workspaceRoot, "report.md");
    const contents = "x".repeat(200_000);
    await fs.writeFile(localPath, contents);

    const drive = createFakeDrive([]);
    const result = await uploadFile(drive, localPath, "report.md", { parentId: "root" });

    assert.equal(result.aethelStreamMd5, md5(Buffer.from(contents)));
    assert.equal(result.md5Checksum, md5(Buffer.from(contents)));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged still fails a commit when Drive stores different bytes", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-upload-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.writeFile(path.join(workspaceRoot, "report.md"), "local content");
    writeIndex(workspaceRoot, {
      staged: [{ action: "upload", path: "report.md", localPath: "report.md" }],
    });

    const drive = createFakeDrive([]);
    const realCreate = drive.files.create.bind(drive.files);
    drive.files.create = async (params) => {
      const response = await realCreate(params);
      return { data: { ...response.data, md5Checksum: "0".repeat(32) } };
    };

    const result = await executeStaged(drive, workspaceRoot);

    assert.equal(result.uploaded, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Upload integrity check failed for report\.md/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("bulk upload starts shallow files before deep subtrees finish", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-tree-"));

  try {
    const deepDir = path.join(workspaceRoot, "deep", "a", "b", "c");
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, "deepest.txt"), "deep");
    await fs.writeFile(path.join(workspaceRoot, "top-1.txt"), "one");
    await fs.writeFile(path.join(workspaceRoot, "top-2.txt"), "two");

    const drive = createFakeDrive([]);
    const created = [];
    const realCreate = drive.files.create.bind(drive.files);
    drive.files.create = async (params) => {
      created.push(params.requestBody.name);
      return realCreate(params);
    };

    const result = await syncLocalDirectoryToParent(drive, workspaceRoot, "root");

    assert.equal(result.uploadedFiles, 3);
    assert.equal(result.uploadedDirectories, 4);
    // Two phases per directory would have held both top-level files until the
    // whole "deep" subtree was done.
    assert.ok(
      created.indexOf("top-1.txt") < created.indexOf("deepest.txt"),
      `expected shallow files to start first, got ${created.join(", ")}`
    );
    assert.ok(created.indexOf("top-2.txt") < created.indexOf("deepest.txt"));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("bulk upload holds the whole tree to one concurrency ceiling", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-tree-"));
  const previousLimit = process.env.AETHEL_DRIVE_CONCURRENCY;

  try {
    // Deep and wide: the old per-level pools multiplied with nesting depth.
    let current = workspaceRoot;
    for (let depth = 0; depth < 4; depth++) {
      current = path.join(current, `level-${depth}`);
      await fs.mkdir(current, { recursive: true });
      for (let i = 0; i < 6; i++) {
        await fs.writeFile(path.join(current, `file-${i}.txt`), `d${depth}-${i}`);
      }
    }

    const drive = createFakeDrive([], { listDelayMs: 2 });
    let inFlight = 0;
    let peakInFlight = 0;
    for (const method of ["create", "list", "update", "get"]) {
      const original = drive.files[method].bind(drive.files);
      drive.files[method] = async (params) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          return await original(params);
        } finally {
          inFlight -= 1;
        }
      };
    }

    const result = await syncLocalDirectoryToParent(drive, workspaceRoot, "root");

    assert.equal(result.uploadedFiles, 24);
    assert.equal(result.uploadedDirectories, 4);
    assert.ok(
      peakInFlight <= 40,
      `expected at most the configured 40 in flight, saw ${peakInFlight}`
    );
  } finally {
    if (previousLimit === undefined) {
      delete process.env.AETHEL_DRIVE_CONCURRENCY;
    } else {
      process.env.AETHEL_DRIVE_CONCURRENCY = previousLimit;
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("syncLocalDirectoryToParent skips paths ignored by .aethelignore", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-ignore-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.writeFile(path.join(workspaceRoot, ".aethelignore"), "venv/\n");
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "venv", "lib"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "keep.txt"), "keep");
    await fs.writeFile(path.join(workspaceRoot, "venv", "lib", "skip.txt"), "skip");

    const drive = createFakeDrive([]);
    const result = await syncLocalDirectoryToParent(drive, workspaceRoot, "root");

    assert.equal(result.uploadedFiles, 1);
    const liveItems = drive.snapshot().filter((item) => !item.trashed);
    assert.equal(liveItems.some((item) => item.name === "keep.txt"), true);
    assert.equal(liveItems.some((item) => item.name === "skip.txt"), false);
    assert.equal(
      liveItems.some((item) => item.mimeType === FOLDER_MIME && item.name === "venv"),
      false
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("syncLocalDirectoryToParent skips built-in nested Rust target directories", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-target-ignore-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "src-tauri", "target", "debug"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "src-tauri", "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src-tauri", "target", "debug", "app.d"), "skip");
    await fs.writeFile(path.join(workspaceRoot, "src-tauri", "src", "main.rs"), "keep");

    const drive = createFakeDrive([]);
    const result = await syncLocalDirectoryToParent(drive, workspaceRoot, "root");

    assert.equal(result.uploadedFiles, 1);
    const liveItems = drive.snapshot().filter((item) => !item.trashed);
    assert.equal(liveItems.some((item) => item.name === "main.rs"), true);
    assert.equal(liveItems.some((item) => item.name === "app.d"), false);
    assert.equal(
      liveItems.some((item) => item.mimeType === FOLDER_MIME && item.name === "target"),
      false
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("syncLocalDirectoryToParent skips files that disappear during upload", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-vanishing-upload-"));

  try {
    await fs.writeFile(path.join(workspaceRoot, "volatile.txt"), "gone soon");

    const drive = createFakeDrive([]);
    const progress = [];
    const result = await syncLocalDirectoryToParent(drive, workspaceRoot, "root", (type, filePath, name) => {
      progress.push({ type, name });
      if (type === "upload" && name === "volatile.txt") {
        fsNative.unlinkSync(filePath);
      }
    });

    assert.equal(result.uploadedFiles, 0);
    assert.deepEqual(progress.map((entry) => entry.type), ["upload", "skip"]);
    assert.equal(drive.snapshot().some((item) => item.name === "volatile.txt"), false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("listIgnoredRemoteItems returns topmost ignored Drive items", async () => {
  const drive = createFakeDrive([
    folder("sync-root", "SyncRoot", "root", "2026-04-04T10:32:00.000Z"),
    folder("build-folder", "build", "sync-root", "2026-04-04T10:33:00.000Z"),
    file("build-child", "out.o", "build-folder", "2026-04-04T10:34:00.000Z", "obj"),
    folder("logs-folder", "logs", "sync-root", "2026-04-04T10:35:00.000Z"),
    file("log-file", "debug.log", "logs-folder", "2026-04-04T10:36:00.000Z", "log"),
    file("keep-file", "notes.md", "sync-root", "2026-04-04T10:37:00.000Z", "notes"),
  ]);
  const ignoreRules = {
    ignores(relativePath) {
      return relativePath === "build" ||
        relativePath.startsWith("build/") ||
        relativePath.endsWith(".log");
    },
  };

  const ignored = await listIgnoredRemoteItems(drive, "sync-root", ignoreRules);

  assert.deepEqual(
    ignored.map((item) => ({ id: item.id, path: item.path, isFolder: Boolean(item.isFolder) })),
    [
      { id: "build-folder", path: "build", isFolder: true },
      { id: "log-file", path: "logs/debug.log", isFolder: false },
    ]
  );
});

test("executeStaged uploads a local edit after its folder was moved by a staged rename", async () => {
  // Machine 1 renamed docs/ -> archive/ on Drive; machine 2 edited a file in
  // docs/ and staged both the pulled move and the upload. The move runs
  // first, so the upload must follow the file to its moved local path —
  // previously it hit ENOENT and trashed the remote file.
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-move-upload-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "notes.md"), "edited");

    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "move_local",
          path: "archive",
          localPath: "archive",
          sourcePath: "docs",
          isFolder: true,
        },
        {
          action: "upload",
          path: "docs/notes.md",
          localPath: "docs/notes.md",
          fileId: "file-1",
          remotePath: "archive/notes.md",
        },
      ],
    });

    const drive = createFakeDrive([
      folder("folder-1", "archive", "root", "2026-04-04T10:00:00.000Z"),
      file("file-1", "notes.md", "folder-1", "2026-04-04T10:00:01.000Z", "old-md5"),
    ]);

    const result = await executeStaged(drive, workspaceRoot);

    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 1);
    assert.equal(result.deletedRemote, 0);

    const remoteFile = drive.snapshot().find((item) => item.id === "file-1");
    assert.equal(remoteFile.trashed, false);
    assert.equal(remoteFile._body, "edited");

    assert.equal(
      await fs.readFile(path.join(workspaceRoot, "archive", "notes.md"), "utf8"),
      "edited"
    );
    assert.equal(
      drive.snapshot().some((item) => item.name === "docs" && !item.trashed),
      false
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged renames a remote folder without a fileId and remaps staged uploads", async () => {
  // Machine 2 renamed docs/ -> archive/ locally and edited a file inside.
  // Non-empty folders carry no ID through the remote listing, so the staged
  // rename resolves the folder by path; the upload staged against the old
  // remote path must land in the renamed folder, not recreate docs/.
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-rename-upload-"));

  try {
    initWorkspace(workspaceRoot, null, "My Drive");
    await fs.mkdir(path.join(workspaceRoot, "archive"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "archive", "notes.md"), "edited");

    writeIndex(workspaceRoot, {
      staged: [
        {
          action: "rename_remote",
          path: "archive",
          localPath: "archive",
          sourcePath: "docs",
          isFolder: true,
        },
        {
          action: "upload",
          path: "archive/notes.md",
          localPath: "archive/notes.md",
          fileId: "file-1",
          remotePath: "docs/notes.md",
        },
      ],
    });

    const drive = createFakeDrive([
      folder("folder-1", "docs", "root", "2026-04-04T10:00:00.000Z"),
      file("file-1", "notes.md", "folder-1", "2026-04-04T10:00:01.000Z", "old-md5"),
    ]);

    const result = await executeStaged(drive, workspaceRoot);

    assert.deepEqual(result.errors, []);
    assert.equal(result.foldersRenamed, 1);
    assert.equal(result.uploaded, 1);

    const remoteFolder = drive.snapshot().find((item) => item.id === "folder-1");
    assert.equal(remoteFolder.name, "archive");

    const remoteFile = drive.snapshot().find((item) => item.id === "file-1");
    assert.equal(remoteFile._body, "edited");
    assert.deepEqual(remoteFile.parents, ["folder-1"]);

    assert.equal(
      drive.snapshot().some((item) => item.name === "docs" && !item.trashed),
      false
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("download failure preserves the previous destination and removes scratch files", async t => {
  const root = createTempDirectory(t, "aethel-preserve-download-");
  const target = path.join(root, "important");
  const drive = {
    files: {
      async get() { throw new Error("access revoked"); },
    },
  };
  await fs.writeFile(target, "original");

  await assert.rejects(
    downloadFile(drive, { id: "f", mimeType: "application/octet-stream" }, target),
    /access revoked/
  );

  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.deepEqual(await fs.readdir(root), ["important"]);
});
