import test from "node:test";
import assert from "node:assert/strict";
import { advanceBaseline } from "../src/core/baseline.js";

function remoteFile(id, filePath, hash) {
  return { id, path: filePath, localPath: filePath, md5Checksum: hash, isFolder: false };
}

function localFile(filePath, hash) {
  return { localPath: filePath, md5: hash };
}

function createPreviousSnapshot() {
  return {
    files: { a: remoteFile("a", "a.txt", "a0"), b: remoteFile("b", "b.txt", "b0") },
    localFiles: { "a.txt": localFile("a.txt", "a0"), "b.txt": localFile("b.txt", "b0") },
  };
}

test("partial pull retains the baseline of unapplied remote modifications", () => {
  const next = advanceBaseline(
    createPreviousSnapshot(),
    [remoteFile("a", "a.txt", "a1"), remoteFile("b", "b.txt", "b1")],
    { files: { "a.txt": localFile("a.txt", "a1"), "b.txt": localFile("b.txt", "b0") } },
    [{ action: "download", path: "a.txt", fileId: "a" }]
  );

  assert.equal(next.remote.find(entry => entry.id === "a").md5Checksum, "a1");
  assert.equal(next.remote.find(entry => entry.id === "b").md5Checksum, "b0");
  assert.equal(next.local.files["b.txt"].md5, "b0");
});

test("folder rename advances paths without swallowing concurrent content edits", () => {
  const previous = {
    files: { a: remoteFile("a", "docs/a.txt", "base") },
    localFiles: { "docs/a.txt": localFile("docs/a.txt", "base") },
  };
  const next = advanceBaseline(
    previous,
    [remoteFile("a", "archive/a.txt", "remote-edit")],
    { files: { "archive/a.txt": localFile("archive/a.txt", "local-edit") } },
    [{ action: "move_local", path: "archive", sourcePath: "docs" }]
  );

  assert.equal(next.remote[0].path, "archive/a.txt");
  assert.equal(next.remote[0].md5Checksum, "base");
  assert.equal(next.local.files["archive/a.txt"].md5, "base");
  assert.equal(next.local.files["docs/a.txt"], undefined);
});

test("deletion acknowledges only its own identity and scope", () => {
  const next = advanceBaseline(
    createPreviousSnapshot(),
    [],
    { files: { "b.txt": localFile("b.txt", "b0") } },
    [{ action: "delete_local", path: "a.txt", fileId: "a" }]
  );

  assert.deepEqual(next.remote.map(entry => entry.id), ["b"]);
  assert.deepEqual(Object.keys(next.local.files), ["b.txt"]);
});

test("a file changed after transfer does not get recorded as synchronized", () => {
  const previous = createPreviousSnapshot();
  const next = advanceBaseline(
    previous,
    [remoteFile("a", "a.txt", "uploaded"), previous.files.b],
    { files: { "a.txt": localFile("a.txt", "edited-again"), "b.txt": previous.localFiles["b.txt"] } },
    [{ action: "upload", path: "a.txt", fileId: "a" }]
  );

  assert.equal(next.remote.find(entry => entry.id === "a").md5Checksum, "a0");
  assert.equal(next.local.files["a.txt"].md5, "a0");
});

test("baseline advancement does not mutate the prior snapshot", () => {
  const previous = createPreviousSnapshot();
  const original = structuredClone(previous);

  advanceBaseline(previous, [], { files: {} }, [
    { action: "delete_remote", path: "a.txt", fileId: "a" },
  ]);

  assert.deepEqual(previous, original);
});

test("a rename retains its ID when the download was staged before the old-path deletion", () => {
  const previous = {
    files: { a: remoteFile("a", "old.txt", "bytes") },
    localFiles: { "old.txt": localFile("old.txt", "bytes") },
  };
  const next = advanceBaseline(
    previous,
    [remoteFile("a", "new.txt", "bytes")],
    { files: { "new.txt": localFile("new.txt", "bytes") } },
    [
      { action: "download", path: "new.txt", fileId: "a" },
      { action: "delete_local", path: "old.txt", fileId: "a" },
    ]
  );

  assert.equal(next.remote.length, 1);
  assert.equal(next.remote[0].path, "new.txt");
  assert.equal(next.local.files["old.txt"], undefined);
});

// The local scan records every folder of an all-empty branch. Once a move or a
// deletion has taken the leaf away, the emptied parents are gone from Drive and
// from disk; a lingering baseline entry for one would later read as a local
// deletion of whatever Drive next puts at that path.

function folderPair(parent, child) {
  return {
    files: { sub: { id: "sub", path: child, localPath: child, isFolder: true } },
    localFiles: {
      [parent]: { localPath: parent, isFolder: true },
      [child]: { localPath: child, isFolder: true },
    },
  };
}

test("a folder move forgets the emptied parent folder that is gone from disk", () => {
  const next = advanceBaseline(
    folderPair("docs", "docs/sub"),
    [{ id: "sub", path: "archive/sub", isFolder: true }],
    { files: {
      archive: { localPath: "archive", isFolder: true },
      "archive/sub": { localPath: "archive/sub", isFolder: true },
    } },
    [{ action: "move_local", path: "archive/sub", sourcePath: "docs/sub", fileId: "sub" }]
  );

  assert.equal(next.local.files.docs, undefined);
  assert.ok(next.local.files["archive/sub"]);
});

test("a folder move keeps the parent folder entry while the parent still exists on disk", () => {
  const next = advanceBaseline(
    folderPair("docs", "docs/sub"),
    [{ id: "sub", path: "archive/sub", isFolder: true }],
    { files: {
      docs: { localPath: "docs", isFolder: true },
      "archive/sub": { localPath: "archive/sub", isFolder: true },
    } },
    [{ action: "move_local", path: "archive/sub", sourcePath: "docs/sub", fileId: "sub" }]
  );

  assert.ok(next.local.files.docs);
});

test("a local folder deletion forgets the emptied parent folder that is gone from disk", () => {
  const next = advanceBaseline(
    folderPair("docs", "docs/sub"),
    [],
    { files: {} },
    [{ action: "delete_local", path: "docs/sub", fileId: "sub" }]
  );

  assert.deepEqual(next.local.files, {});
  assert.deepEqual(next.remote, []);
});

// The reverse of the cases above: the emptied folder survives on both sides.
// Its baseline entry has to appear now, or deleting it later reads as a folder
// that is new on Drive (it has no entry to be a deletion of).

function nestedFilePrevious() {
  return {
    files: { a: remoteFile("a", "docs/sub/a.txt", "a0") },
    localFiles: { "docs/sub/a.txt": localFile("docs/sub/a.txt", "a0") },
  };
}

test("a remote deletion that empties a folder records the folder and its empty parent", () => {
  const next = advanceBaseline(
    nestedFilePrevious(),
    [{ id: "sub", path: "docs/sub", isFolder: true }],
    { files: {
      docs: { localPath: "docs", isFolder: true },
      "docs/sub": { localPath: "docs/sub", isFolder: true },
    } },
    [{ action: "delete_remote", path: "docs/sub/a.txt", fileId: "a" }]
  );

  assert.deepEqual(Object.keys(next.local.files).sort(), ["docs", "docs/sub"]);
  assert.ok(next.local.files["docs/sub"].isFolder);
  // Drive lists only the leaf of an empty branch, so only the leaf has an ID.
  assert.deepEqual(next.remote.map(entry => [entry.id, entry.path]), [["sub", "docs/sub"]]);
});

test("a local deletion applied from Drive records the empty folder it leaves behind", () => {
  const next = advanceBaseline(
    nestedFilePrevious(),
    [{ id: "sub", path: "docs/sub", isFolder: true }],
    { files: {
      docs: { localPath: "docs", isFolder: true },
      "docs/sub": { localPath: "docs/sub", isFolder: true },
    } },
    [{ action: "delete_local", path: "docs/sub/a.txt", fileId: "a" }]
  );

  assert.ok(next.local.files["docs/sub"].isFolder);
  assert.equal(next.remote.find(entry => entry.id === "sub").path, "docs/sub");
});

test("a deletion does not record a folder that still holds files", () => {
  const previous = nestedFilePrevious();
  previous.files.b = remoteFile("b", "docs/sub/b.txt", "b0");
  previous.localFiles["docs/sub/b.txt"] = localFile("docs/sub/b.txt", "b0");
  const next = advanceBaseline(
    previous,
    [previous.files.b],
    { files: { "docs/sub/b.txt": previous.localFiles["docs/sub/b.txt"] } },
    [{ action: "delete_remote", path: "docs/sub/a.txt", fileId: "a" }]
  );

  assert.deepEqual(Object.keys(next.local.files), ["docs/sub/b.txt"]);
  assert.deepEqual(next.remote.map(entry => entry.id), ["b"]);
});

test("a deletion does not record an emptied folder that Drive no longer has", () => {
  const next = advanceBaseline(
    nestedFilePrevious(),
    [],
    { files: { docs: { localPath: "docs", isFolder: true }, "docs/sub": { localPath: "docs/sub", isFolder: true } } },
    [{ action: "delete_remote", path: "docs/sub/a.txt", fileId: "a" }]
  );

  assert.deepEqual(next.local.files, {});
  assert.deepEqual(next.remote, []);
});

test("a folder emptied by an unrelated change is not recorded", () => {
  const previous = createPreviousSnapshot();
  const next = advanceBaseline(
    previous,
    [{ id: "empty", path: "empty", isFolder: true }, previous.files.b],
    { files: {
      "b.txt": previous.localFiles["b.txt"],
      empty: { localPath: "empty", isFolder: true },
    } },
    [{ action: "delete_remote", path: "a.txt", fileId: "a" }]
  );

  assert.equal(next.local.files.empty, undefined);
  assert.equal(next.remote.find(entry => entry.id === "empty"), undefined);
});
