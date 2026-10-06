import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { latestSnapshotPath } from "../src/core/config.js";
import { fullPullDownloadOptions } from "../src/core/staging.js";
import {
  createFolderFixture,
  describeDiff,
  localDirectories,
  remoteDirectories,
} from "../test-support/folder-fixture.js";

// Applying "this folder was deleted on Drive" removes the local tree. It must
// never take local work with it: files Drive never had, and edits it has not
// seen, exist nowhere else.

async function trash(fixture, folderPath) {
  await fixture.drive.files.update({ fileId: fixture.ids.get(folderPath), requestBody: { trashed: true } });
  await fixture.refreshRemote();
}

async function exists(device, relativePath) {
  return fs.access(path.join(device, ...relativePath.split("/"))).then(() => true, () => false);
}

function summary(changes) {
  return changes.map((change) => `${change.changeType} ${change.path}`).sort();
}

/** Pull exactly what Drive changed — what `aethel pull` stages. */
async function pull(fixture) {
  const { repo } = fixture;
  const state = await repo.loadState({ useCache: false });
  repo.stageChanges(state.diff.remoteChanges);
  const result = await repo.commitStaged({ message: "pull" });
  return { before: state, result };
}

test("pull keeps a local file that was never uploaded inside a folder deleted on Drive", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt", "docs/sub/b.txt"]);
  const { device, repo, refreshRemote } = fixture;
  await fs.writeFile(path.join(device, "docs", "new.txt"), "my new work");
  await trash(fixture, "docs");

  const { before, result } = await pull(fixture);

  assert.deepEqual(summary(before.diff.localChanges), ["local_added docs/new.txt"], describeDiff(before.diff));
  assert.deepEqual(result.errors, []);
  assert.equal(await fs.readFile(path.join(device, "docs", "new.txt"), "utf8"), "my new work");
  // What Drive had is gone, and so are the folders that emptied out.
  assert.equal(await exists(device, "docs/a.txt"), false);
  assert.equal(await exists(device, "docs/sub"), false);

  // The surviving file is an ordinary local addition: pushing it recreates the folder.
  const after = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(after.diff.changes), ["local_added docs/new.txt"], describeDiff(after.diff));
  repo.stageChanges(after.diff.localChanges);
  assert.deepEqual((await repo.commitStaged({ message: "push" })).errors, []);
  assert.deepEqual(remoteDirectories(await refreshRemote()), ["docs"]);
  assert.equal((await repo.loadState({ useCache: false })).diff.isClean, true);
});

test("pull keeps a local edit to a file inside a folder deleted on Drive and reports a conflict", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt", "docs/b.txt"]);
  const { device } = fixture;
  await fs.writeFile(path.join(device, "docs", "a.txt"), "edited locally");
  await trash(fixture, "docs");

  const { before, result } = await pull(fixture);

  assert.deepEqual(summary(before.diff.conflicts), ["conflict docs/a.txt"], describeDiff(before.diff));
  assert.deepEqual(result.errors, []);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "edited locally");
  assert.equal(await exists(device, "docs/b.txt"), false);
});

test("pull does not delete a file edited after its deletion was planned", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt", "docs/b.txt"]);
  const { device, repo, drive, ids, refreshRemote } = fixture;
  await drive.files.update({ fileId: ids.get("docs/a.txt"), requestBody: { trashed: true } });
  await refreshRemote();

  // Plan the deletion while the file is still as synced, then edit it before it is applied.
  const planned = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(planned.diff.remoteChanges), ["remote_deleted docs/a.txt"], describeDiff(planned.diff));
  repo.stageChanges(planned.diff.remoteChanges);
  await fs.writeFile(path.join(device, "docs", "a.txt"), "edited after the plan was made");

  const result = await repo.commitStaged({ message: "pull" });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to delete docs\/a\.txt: it changed locally/);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "edited after the plan was made");
  assert.equal(await exists(device, "docs/b.txt"), true);

  // Nothing was acknowledged, so the next comparison reports the clash.
  const after = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(after.diff.conflicts), ["conflict docs/a.txt"], describeDiff(after.diff));
});

/** Drive rewrites `docs/a.txt`, as another device uploading a new version would. */
async function changeOnDrive(fixture, filePath, content) {
  await fixture.drive.files.update({
    fileId: fixture.ids.get(filePath),
    media: { body: Readable.from([content]) },
  });
  await fixture.refreshRemote();
}

test("pull replaces a file that is unchanged since the last sync with the Drive version", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  const { device } = fixture;
  await changeOnDrive(fixture, "docs/a.txt", "changed on Drive");

  const { result } = await pull(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "changed on Drive");
});

test("pull does not overwrite a file edited after the download was planned", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  const { device, repo } = fixture;
  await changeOnDrive(fixture, "docs/a.txt", "changed on Drive");

  const planned = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(planned.diff.remoteChanges), ["remote_modified docs/a.txt"], describeDiff(planned.diff));
  repo.stageChanges(planned.diff.remoteChanges);
  await fs.writeFile(path.join(device, "docs", "a.txt"), "edited after the plan was made");

  const result = await repo.commitStaged({ message: "pull" });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to overwrite docs\/a\.txt: it changed locally/);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "edited after the plan was made");

  const after = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(after.diff.conflicts), ["conflict docs/a.txt"], describeDiff(after.diff));
});

/** What `aethel pull --all [--force]` stages, as the CLI builds it. */
async function stageFullPull(fixture, { force = false } = {}) {
  const state = await fixture.repo.loadState({ useCache: false });
  fixture.repo.stageFullRemotePull(
    state.remote,
    [],
    [],
    fullPullDownloadOptions({ force, local: state.local })
  );
}

test("pull --all keeps a locally edited file and still downloads everything else", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt", "docs/b.txt"]);
  const { device, repo } = fixture;
  await changeOnDrive(fixture, "docs/b.txt", "changed on Drive");
  await fs.writeFile(path.join(device, "docs", "a.txt"), "edit that exists at planning");

  await stageFullPull(fixture);
  const result = await repo.commitStaged({ message: "pull --all" });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Refusing to overwrite docs\/a\.txt: it changed locally since the last sync/);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "edit that exists at planning");
  assert.equal(await fs.readFile(path.join(device, "docs", "b.txt"), "utf8"), "changed on Drive");
  assert.equal(await fs.readFile(path.join(device, "keep.txt"), "utf8"), "content of keep.txt");

  // The kept edit is still a local change, to push or to replace with --force.
  const after = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(after.diff.changes), ["local_modified docs/a.txt"], describeDiff(after.diff));
});

test("pull --all --force replaces a local edit, but not one made after it was planned", async (t) => {
  const replaced = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  await fs.writeFile(path.join(replaced.device, "docs", "a.txt"), "edit that exists at planning");
  await stageFullPull(replaced, { force: true });
  assert.deepEqual((await replaced.repo.commitStaged({ message: "pull --all --force" })).errors, []);
  assert.equal(
    await fs.readFile(path.join(replaced.device, "docs", "a.txt"), "utf8"),
    "content of docs/a.txt",
    "the edit that existed when --force was given is replaced"
  );

  const protectedFixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  await stageFullPull(protectedFixture, { force: true });
  await fs.writeFile(path.join(protectedFixture.device, "docs", "a.txt"), "edit made after planning");
  const result = await protectedFixture.repo.commitStaged({ message: "pull --all --force" });
  assert.match(result.errors[0], /Refusing to overwrite docs\/a\.txt: it was edited after you chose/);
  assert.equal(
    await fs.readFile(path.join(protectedFixture.device, "docs", "a.txt"), "utf8"),
    "edit made after planning"
  );
});

test("pull --all into a folder that already holds a different file keeps it unless forced", async (t) => {
  const fixture = await createFolderFixture(t, ["docs/a.txt"]);
  const { device, repo } = fixture;
  // A workspace with no baseline yet: the first full download.
  await fs.rm(latestSnapshotPath(device));
  await fs.writeFile(path.join(device, "docs", "a.txt"), "a file that was here first");

  await stageFullPull(fixture);
  const refused = await repo.commitStaged({ message: "first pull" });
  assert.match(refused.errors[0], /a different local file is already there that Drive has not synced/);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "a file that was here first");

  repo.unstageAll();
  await stageFullPull(fixture, { force: true });
  assert.deepEqual((await repo.commitStaged({ message: "first pull" })).errors, []);
  assert.equal(await fs.readFile(path.join(device, "docs", "a.txt"), "utf8"), "content of docs/a.txt");
});

test("resolve --theirs replaces the conflicting local file, but not one edited after choosing", async (t) => {
  async function conflictOnA(fixture) {
    await changeOnDrive(fixture, "docs/a.txt", "changed on Drive");
    await fs.writeFile(path.join(fixture.device, "docs", "a.txt"), "my edit");
    const state = await fixture.repo.loadState({ useCache: false });
    assert.deepEqual(summary(state.diff.conflicts), ["conflict docs/a.txt"], describeDiff(state.diff));
    fixture.repo.stageConflictResolution(state.diff.conflicts[0], "theirs");
  }

  const chosen = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  await conflictOnA(chosen);
  assert.deepEqual((await chosen.repo.commitStaged({ message: "resolve" })).errors, []);
  assert.equal(await fs.readFile(path.join(chosen.device, "docs", "a.txt"), "utf8"), "changed on Drive");

  const editedAfter = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  await conflictOnA(editedAfter);
  await fs.writeFile(path.join(editedAfter.device, "docs", "a.txt"), "a second edit, after choosing");
  const result = await editedAfter.repo.commitStaged({ message: "resolve" });
  assert.match(result.errors[0], /Refusing to overwrite docs\/a\.txt: it was edited after you chose/);
  assert.equal(
    await fs.readFile(path.join(editedAfter.device, "docs", "a.txt"), "utf8"),
    "a second edit, after choosing"
  );
});

test("pull keeps work added to an empty folder that was deleted on Drive", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "x/"]);
  const { device, repo } = fixture;
  await fs.writeFile(path.join(device, "x", "new.txt"), "filled since");
  await trash(fixture, "x");

  const { result } = await pull(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(await fs.readFile(path.join(device, "x", "new.txt"), "utf8"), "filled since");
  const after = await repo.loadState({ useCache: false });
  assert.deepEqual(summary(after.diff.changes), ["local_added x/new.txt"], describeDiff(after.diff));
});

test("pull keeps a file that is recorded in the baseline but never reached Drive", async (t) => {
  // saveSnapshot() records every scanned file in the local baseline, uploaded or
  // not, so being in the baseline does not mean Drive has the file.
  const fixture = await createFolderFixture(t, ["docs/a.txt"], { localOnly: ["docs/draft.txt"] });
  const { device } = fixture;
  await trash(fixture, "docs");

  const { result } = await pull(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(await fs.readFile(path.join(device, "docs", "draft.txt"), "utf8"), "content of docs/draft.txt");
  assert.equal(await exists(device, "docs/a.txt"), false);
});

test("pull still removes whole subfolders that hold no local work", async (t) => {
  const fixture = await createFolderFixture(t, ["docs/a.txt", "docs/keep/k.txt", "docs/sub/b.txt"]);
  const { device } = fixture;
  await fs.writeFile(path.join(device, "docs", "keep", "new.txt"), "mine");
  await trash(fixture, "docs");

  const { result } = await pull(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(await exists(device, "docs/sub"), false, "a subfolder with no local work is removed as a whole");
  assert.equal(await exists(device, "docs/a.txt"), false);
  assert.equal(await exists(device, "docs/keep/k.txt"), false);
  assert.equal(await fs.readFile(path.join(device, "docs", "keep", "new.txt"), "utf8"), "mine");
  assert.deepEqual(await localDirectories(device), ["docs", "docs/keep"]);
});

test("pull still deletes ignored files together with a folder deleted on Drive", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "docs/a.txt"]);
  const { device } = fixture;
  await fs.writeFile(path.join(device, ".aethelignore"), "*.log\n");
  await fs.writeFile(path.join(device, "docs", "debug.log"), "ignored noise");
  await trash(fixture, "docs");

  const { result } = await pull(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(await exists(device, "docs"), false);
});
