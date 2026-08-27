import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
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

const FOLDER_MIME = "application/vnd.google-apps.folder";

function folder(id, name, parentId, createdTime) {
  return {
    id,
    name,
    mimeType: FOLDER_MIME,
    parents: parentId ? [parentId] : [],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum: null,
    size: null,
    capabilities: {
      canAddChildren: true,
      canEdit: true,
      canTrash: true,
      canDelete: true,
      canRename: true,
    },
    trashed: false,
  };
}

function file(id, name, parentId, createdTime, md5Checksum) {
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    parents: [parentId],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum,
    size: 1,
    capabilities: {
      canAddChildren: false,
      canEdit: true,
      canTrash: true,
      canDelete: true,
      canRename: true,
    },
    trashed: false,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

function createFakeDrive(initialItems = [], { listDelayMs = 0 } = {}) {
  const items = new Map(initialItems.map((item) => [item.id, clone(item)]));
  let sequence = 0;
  let idCounter = 1000;
  let changeSequence = 0;
  const changesLog = [];
  const listQueries = [];

  function recordChange(item, removed = false) {
    changesLog.push({
      seq: ++changeSequence,
      fileId: item.id,
      removed,
      file: removed ? undefined : clone(item),
    });
  }

  function decodeQueryValue(value) {
    return value.replace(/\\\\/g, "\\").replace(/\\'/g, "'");
  }

  function matches(item, query) {
    if (!query) {
      return true;
    }

    return query.split(" and ").every((part) => {
      if (part === "trashed = false") {
        return !item.trashed;
      }

      const nameMatch = part.match(/^name = '(.+)'$/);
      if (nameMatch) {
        return item.name === decodeQueryValue(nameMatch[1]);
      }

      const mimeMatch = part.match(/^mimeType = '(.+)'$/);
      if (mimeMatch) {
        return item.mimeType === decodeQueryValue(mimeMatch[1]);
      }

      const mimeExclusionMatch = part.match(/^mimeType != '(.+)'$/);
      if (mimeExclusionMatch) {
        return item.mimeType !== decodeQueryValue(mimeExclusionMatch[1]);
      }

      const parentMatch = part.match(/^'(.+)' in parents$/);
      if (parentMatch) {
        return (item.parents || []).includes(parentMatch[1]);
      }

      return true;
    });
  }

  async function drain(stream) {
    if (!stream) {
      return Buffer.alloc(0);
    }

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function touch(item) {
    item.modifiedTime = new Date(1700000000000 + sequence++).toISOString();
  }

  return {
    files: {
      async list({ q, pageSize = 1000, pageToken, orderBy }) {
        if (listDelayMs) {
          await delay(listDelayMs);
        }

        listQueries.push(q || "");

        const matchesQuery = [...items.values()].filter((item) => matches(item, q));
        matchesQuery.sort((left, right) => {
          if (orderBy === "createdTime desc") {
            return Date.parse(right.createdTime) - Date.parse(left.createdTime);
          }
          return String(left.id).localeCompare(String(right.id));
        });

        const start = Number(pageToken || 0);
        const slice = matchesQuery.slice(start, start + pageSize).map(clone);
        const nextPageToken =
          start + pageSize < matchesQuery.length ? String(start + pageSize) : undefined;

        return {
          data: {
            files: slice,
            nextPageToken,
          },
        };
      },
      async create({ requestBody, media }) {
        const body = await drain(media?.body);
        const id = `id-${++idCounter}`;
        const createdTime = new Date(1700000000000 + sequence++).toISOString();
        const item = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || "application/octet-stream",
          parents: requestBody.parents || [],
          createdTime,
          modifiedTime: createdTime,
          md5Checksum: requestBody.mimeType === FOLDER_MIME ? null : md5(body),
          size: requestBody.mimeType === FOLDER_MIME ? null : body.length,
          capabilities: {
            canAddChildren: true,
            canEdit: true,
            canTrash: true,
            canDelete: true,
            canRename: true,
          },
          trashed: false,
          _body: body.toString("utf8"),
        };
        items.set(id, item);
        recordChange(item);
        return { data: clone(item) };
      },
      async update({ fileId, requestBody = {}, addParents, removeParents, media }) {
        const body = await drain(media?.body);
        const item = items.get(fileId);

        if (!item) {
          const err = new Error(`File not found: ${fileId}`);
          err.code = 404;
          throw err;
        }

        if (requestBody.name) {
          item.name = requestBody.name;
        }

        if (Object.hasOwn(requestBody, "trashed")) {
          item.trashed = Boolean(requestBody.trashed);
        }

        if (addParents || removeParents) {
          const nextParents = new Set(item.parents || []);
          for (const parentId of String(removeParents || "")
            .split(",")
            .filter(Boolean)) {
            nextParents.delete(parentId);
          }
          if (addParents) {
            nextParents.add(addParents);
          }
          item.parents = [...nextParents];
        }

        if (body.length && item.mimeType !== FOLDER_MIME) {
          item._body = body.toString("utf8");
          item.md5Checksum = md5(body);
          item.size = body.length;
        }

        touch(item);
        recordChange(item);
        return { data: clone(item) };
      },
      async delete({ fileId }) {
        const item = items.get(fileId);
        items.delete(fileId);
        if (item) {
          recordChange(item, true);
        }
        return { data: {} };
      },
      async get({ fileId, alt }) {
        if (fileId === "root") {
          return {
            data: {
              id: "root",
              name: "My Drive",
              mimeType: FOLDER_MIME,
              parents: [],
              capabilities: {
                canAddChildren: true,
                canEdit: true,
              },
            },
          };
        }

        if (alt === "media") {
          return { data: Readable.from([items.get(fileId)?._body || ""]) };
        }

        return { data: clone(items.get(fileId)) };
      },
    },
    changes: {
      async getStartPageToken() {
        return { data: { startPageToken: String(changeSequence) } };
      },
      async list({ pageToken }) {
        const since = Number(pageToken || 0);
        return {
          data: {
            changes: changesLog
              .filter((change) => change.seq > since)
              .map(({ seq, ...change }) => clone(change)),
            newStartPageToken: String(changeSequence),
          },
        };
      },
    },
    snapshot() {
      return [...items.values()]
        .map(clone)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    },
    listQueries() {
      return [...listQueries];
    },
    clearListQueries() {
      listQueries.length = 0;
    },
  };
}

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
    data: { changes: memoChanges.map(clone), newStartPageToken: "999" },
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

test("executeStaged treats missing staged upload source as local deletion", async () => {
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

    assert.equal(result.errors.length, 0);
    assert.equal(result.deletedRemote, 1);
    assert.equal(result.uploaded, 0);
    assert.equal(readIndex(workspaceRoot).staged.length, 0);
    assert.equal(drive.snapshot().find((item) => item.id === "remote-file").trashed, true);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("executeStaged drops missing staged upload source when no remote exists", async () => {
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

    assert.equal(result.errors.length, 0);
    assert.equal(result.total, 0);
    assert.equal(readIndex(workspaceRoot).staged.length, 0);
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

test("uploadFile falls back from a stale fileId to same-name remote file", async () => {
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
      existingId: "stale-id",
      cleanupDuplicates: true,
    });

    const snapshot = drive.snapshot();
    const activeReports = snapshot.filter((item) => item.name === "report.md" && !item.trashed);
    const trashedReports = snapshot.filter((item) => item.name === "report.md" && item.trashed);

    assert.equal(result.id, "remote-1");
    assert.equal(activeReports.length, 1);
    assert.equal(activeReports[0].md5Checksum, md5(Buffer.from("new content")));
    assert.deepEqual(trashedReports.map((item) => item.id), ["remote-2"]);
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
