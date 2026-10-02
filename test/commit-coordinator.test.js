import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readIndex, writeIndex, writeSnapshot, readLatestSnapshot } from "../src/core/config.js";
import { Repository } from "../src/core/repository.js";
import { buildSnapshot, scanLocal } from "../src/core/snapshot.js";
import { openExecutionJournal } from "../src/core/execution-journal.js";
import { createTestWorkspace } from "../test-support/workspace.js";
import { createFakeDrive, folder } from "../test-support/fake-drive.js";

async function createCommitFixture(t) {
  const root = createTestWorkspace(t, { prefix: "aethel-coordinator-", driveFolderId: "root-id" });
  fs.writeFileSync(path.join(root, "tracked.txt"), "original");
  const local = await scanLocal(root);
  const remoteFile = {
    id: "tracked",
    path: "tracked.txt",
    md5Checksum: local.files["tracked.txt"].md5,
  };
  writeSnapshot(root, buildSnapshot([remoteFile], local));
  const drive = createFakeDrive([
    folder("root-id", "root", "root", "2026-04-04T10:00:00.000Z"),
  ]);
  const repo = new Repository(root, { drive });
  const deletion = { action: "delete_local", path: "tracked.txt", fileId: "tracked" };
  return { root, repo, deletion };
}

test("partial failure checkpoints successful effects and retains only failed staging", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion, { action: "unknown", path: "failed.txt" }] });
  const result = await repo.commitStaged();
  assert.equal(result.errors.length, 1);
  assert.equal(result.baselineSaved, true);
  assert.equal(fs.existsSync(path.join(root, "tracked.txt")), false);
  assert.equal(readLatestSnapshot(root).files.tracked, undefined);
  assert.deepEqual(readIndex(root).staged.map(entry => entry.path), ["failed.txt"]);
  assert.equal(openExecutionJournal(root).completed().length, 0);
  const retry = await repo.commitStaged();
  assert.equal(retry.deletedLocal, 0);
  assert.equal(readLatestSnapshot(root).files.tracked, undefined);
});

test("baseline write failure preserves receipts and the next commit completes the checkpoint", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion] });
  const saveFailure = t.mock.method(repo, "saveSnapshot", async () => {
    throw new Error("disk unavailable");
  });
  await assert.rejects(repo.commitStaged(), /disk unavailable/);
  assert.equal(openExecutionJournal(root).completed().length, 1);
  assert.equal(readLatestSnapshot(root).files.tracked.path, "tracked.txt");
  assert.deepEqual(readIndex(root).staged, []);
  saveFailure.mock.restore();
  const result = await repo.commitStaged();
  assert.equal(result.deletedLocal, 0);
  assert.equal(result.baselineSaved, true);
  assert.equal(readLatestSnapshot(root).files.tracked, undefined);
  assert.equal(openExecutionJournal(root).completed().length, 0);
});

test("crash after snapshot persistence does not advance the same operations twice", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion] });
  const save = repo.saveSnapshot.bind(repo);
  const saveFailure = t.mock.method(repo, "saveSnapshot", async (...args) => {
    await save(...args);
    throw new Error("crash after snapshot");
  });
  await assert.rejects(repo.commitStaged(), /crash after snapshot/);
  assert.equal(openExecutionJournal(root).completed().length, 1);
  await repo.commitStaged();
  assert.equal(saveFailure.mock.callCount(), 1);
  assert.equal(openExecutionJournal(root).completed().length, 0);
});

test("durable completion before staging cleanup is recovered without replay", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion] });
  const journal = openExecutionJournal(root);
  const id = journal.newId();
  journal.record(id, "started", deletion, deletion);
  fs.unlinkSync(path.join(root, "tracked.txt"));
  journal.record(id, "completed", deletion, deletion);
  const result = await repo.commitStaged();
  assert.equal(result.deletedLocal, 0);
  assert.deepEqual(readIndex(root).staged, []);
  assert.equal(readLatestSnapshot(root).files.tracked, undefined);
});

test("uncertain interrupted operations stop without replaying mutations", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion] });
  const journal = openExecutionJournal(root);
  journal.record(journal.newId(), "started", deletion, deletion);
  await assert.rejects(repo.commitStaged(), error => error.code === "RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(path.join(root, "tracked.txt")), true);
  assert.equal(readIndex(root).staged.length, 1);
});

test("truncated completion record retains an uncertain start", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  const journal = openExecutionJournal(root);
  journal.record(journal.newId(), "started", deletion, deletion);
  fs.appendFileSync(path.join(root, ".aethel", "execution.jsonl"), '{"version":1,"state":"comple');
  await assert.rejects(repo.commitStaged(), error => error.code === "RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(path.join(root, "tracked.txt")), true);
});

test("failed folder move blocks dependent deletion but permits independent work", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  fs.mkdirSync(path.join(root, "target"));
  fs.writeFileSync(path.join(root, "target", "keep.txt"), "keep");
  writeIndex(root, { staged: [
    { action: "move_local", sourcePath: "missing", path: "target" },
    { action: "delete_local", path: "target/keep.txt" }, deletion,
  ] });
  const result = await repo.commitStaged();
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some(error => error.includes("Dependency failed")));
  assert.equal(fs.readFileSync(path.join(root, "target", "keep.txt"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(root, "tracked.txt")), false);
  assert.equal(readIndex(root).staged.length, 2);
});

test("journal storage failure stops before mutations", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion] });
  fs.mkdirSync(path.join(root, ".aethel", "execution.jsonl"));
  await assert.rejects(repo.commitStaged());
  assert.equal(fs.existsSync(path.join(root, "tracked.txt")), true);
  assert.equal(readIndex(root).staged.length, 1);
});

test("receipt write failure preserves the uncertain operation and aborts checkpointing", async t => {
  const { root, repo, deletion } = await createCommitFixture(t);
  writeIndex(root, { staged: [deletion] });
  const originalWrite = fs.writeFileSync;
  const mock = t.mock.method(fs, "writeFileSync", function (target, text, ...args) {
    if (typeof text === "string" && text.includes('"state":"completed"')) {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    return originalWrite.call(fs, target, text, ...args);
  });
  await assert.rejects(repo.commitStaged(), error => error.code === "JOURNAL_IO");
  mock.mock.restore();
  assert.equal(fs.existsSync(path.join(root, "tracked.txt")), false);
  assert.equal(readIndex(root).staged.length, 1);
  assert.ok(readLatestSnapshot(root).files.tracked);
  assert.throws(() => openExecutionJournal(root).assertRecoverable(), error => error.code === "RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(path.join(root, ".aethel", "sync.lock")), false);
});
