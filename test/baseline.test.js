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
