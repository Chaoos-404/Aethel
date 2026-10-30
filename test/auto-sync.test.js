import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getRemoteState } from "../src/core/drive-api.js";
import {
  conflictChoices,
  describeConflict,
  planSync,
  resolveConflict,
  runSyncCycle,
} from "../src/core/auto-sync.js";
import { ChangeType } from "../src/core/diff.js";
import {
  createSyncFixture as createFixture,
  diverge,
  MEMO_OPTIONS,
  ROOT_ID,
} from "../test-support/sync-fixture.js";

const read = (root, name) => fs.readFile(path.join(root, name), "utf8");

test("a cycle syncs one-sided changes both ways and holds back the conflict", async (t) => {
  const fixture = await createFixture(t);
  await diverge(fixture);

  const phases = [];
  const outcome = await runSyncCycle(fixture.repo, { onPhase: (phase) => phases.push(phase) });

  assert.deepEqual(phases, ["scan", "apply"]);
  assert.equal(outcome.pulled, 1);
  assert.equal(outcome.pushed, 1);
  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(outcome.conflicts.map((c) => c.path), ["fight.txt"]);

  assert.equal(await read(fixture.root, "new-remote.txt"), "from drive");
  assert.equal(await read(fixture.root, "fight.txt"), "local edit", "conflict is untouched");
  const remote = await getRemoteState(fixture.drive, ROOT_ID, null, MEMO_OPTIONS);
  assert.ok(remote.files.some((file) => file.path === "new-local.txt"));
  assert.deepEqual(fixture.repo.getStagedEntries(), []);

  // The conflict keeps being reported, and nothing is re-applied.
  const again = await runSyncCycle(fixture.repo);
  assert.deepEqual(again.conflicts.map((c) => c.path), ["fight.txt"]);
  assert.equal(again.pulled + again.pushed, 0);
});

test("keeping the Drive version of a conflict downloads it on the next cycle", async (t) => {
  const fixture = await createFixture(t);
  await diverge(fixture);
  const [conflict] = (await runSyncCycle(fixture.repo)).conflicts;

  resolveConflict(fixture.repo, conflict, "remote");
  const outcome = await runSyncCycle(fixture.repo);

  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(outcome.conflicts, []);
  assert.equal(await read(fixture.root, "fight.txt"), "remote edit");
});

test("keeping the local version of a conflict uploads it on the next cycle", async (t) => {
  const fixture = await createFixture(t);
  await diverge(fixture);
  const [conflict] = (await runSyncCycle(fixture.repo)).conflicts;

  resolveConflict(fixture.repo, conflict, "local");
  const outcome = await runSyncCycle(fixture.repo);

  assert.deepEqual(outcome.errors, []);
  assert.deepEqual(outcome.conflicts, []);
  assert.equal(await read(fixture.root, "fight.txt"), "local edit");
  const remote = await getRemoteState(fixture.drive, ROOT_ID, null, MEMO_OPTIONS);
  const fight = remote.files.find((file) => file.path === "fight.txt");
  const downloaded = await fixture.drive.files.get(
    { fileId: fight.id, alt: "media" },
    { responseType: "stream" }
  );
  const chunks = [];
  for await (const chunk of downloaded.data) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString("utf8"), "local edit");
});

test("keeping both leaves the Drive copy beside the local file", async (t) => {
  const fixture = await createFixture(t);
  await diverge(fixture);
  const [conflict] = (await runSyncCycle(fixture.repo)).conflicts;

  resolveConflict(fixture.repo, conflict, "both");
  const outcome = await runSyncCycle(fixture.repo);

  assert.deepEqual(outcome.errors, []);
  assert.equal(await read(fixture.root, "fight.txt"), "local edit");
  assert.equal(await read(fixture.root, "fight.remote.txt"), "remote edit");
});

test("a resolution that is staged but not yet applied is not asked about again", async (t) => {
  const fixture = await createFixture(t);
  await diverge(fixture);
  const [conflict] = (await runSyncCycle(fixture.repo)).conflicts;

  resolveConflict(fixture.repo, conflict, "local");
  const { diff } = await fixture.repo.loadState({ useCache: false });
  const plan = planSync(diff, new Set(fixture.repo.getStagedEntries().map((e) => e.path)));

  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.resolving.map((c) => c.path), ["fight.txt"]);
});

test("without a baseline snapshot a cycle does nothing", async (t) => {
  const fixture = await createFixture(t, { baseline: false });
  await fs.writeFile(path.join(fixture.root, "new-local.txt"), "from here");

  const outcome = await runSyncCycle(fixture.repo);

  assert.equal(outcome.skipped, "no-baseline");
  const remote = await getRemoteState(fixture.drive, ROOT_ID, null, MEMO_OPTIONS);
  assert.equal(remote.files.some((file) => file.path === "new-local.txt"), false);
});

test("changes under a conflicted folder are held back with it", () => {
  const change = (changeType, changePath, extra = {}) => ({ changeType, path: changePath, ...extra });
  const diff = {
    conflicts: [change(ChangeType.CONFLICT, "docs")],
    changes: [
      change(ChangeType.CONFLICT, "docs"),
      change(ChangeType.REMOTE_ADDED, "docs/a.txt"),
      change(ChangeType.LOCAL_MODIFIED, "docs-other/b.txt"),
      change(ChangeType.REMOTE_RENAMED, "moved/c.txt", { sourcePath: "docs/c.txt" }),
      change(ChangeType.REMOTE_ADDED, "free.txt"),
    ],
    packConflicts: [],
  };

  const plan = planSync(diff);

  assert.deepEqual(plan.held.map((c) => c.path), ["docs/a.txt", "moved/c.txt"]);
  assert.deepEqual(plan.pull.map((c) => c.path), ["free.txt"]);
  assert.deepEqual(plan.push.map((c) => c.path), ["docs-other/b.txt"]);
});

test("conflict choices only offer sides that exist", () => {
  const both = { path: "a", localMeta: { md5: "1" }, remoteMeta: { md5Checksum: "2" } };
  const remoteGone = { path: "a", localMeta: { md5: "1" }, remoteMeta: null };
  const localGone = { path: "a", localMeta: null, remoteMeta: { md5Checksum: "2" } };

  assert.deepEqual(conflictChoices(both), ["local", "remote", "both"]);
  assert.deepEqual(conflictChoices(remoteGone), ["local"]);
  assert.deepEqual(conflictChoices(localGone), ["local", "remote"]);

  assert.throws(() => resolveConflict({}, remoteGone, "remote"), /that side does not exist/);
  assert.throws(() => resolveConflict({}, both, "sideways"), /Unknown conflict choice/);
});

test("describeConflict summarises both sides", () => {
  const described = describeConflict({
    path: "a.txt",
    localMeta: { md5: "aaaa", size: 3, modifiedTime: "2026-01-01T00:00:00Z" },
    remoteMeta: { md5Checksum: "bbbb", size: "5", modifiedTime: "2026-01-02T00:00:00Z" },
  });

  assert.equal(described.kind, "both sides changed");
  assert.deepEqual(described.local, {
    present: true, size: 3, modifiedTime: "2026-01-01T00:00:00Z", md5: "aaaa", isFolder: false,
  });
  assert.equal(described.remote.size, 5);
  assert.equal(described.remote.md5, "bbbb");
  assert.equal(
    describeConflict({ path: "a", localMeta: null, remoteMeta: {} }).kind,
    "deleted locally, changed on Drive"
  );
  assert.equal(
    describeConflict({ path: "a", localMeta: {}, remoteMeta: null }).kind,
    "changed locally, deleted on Drive"
  );
});
