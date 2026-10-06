import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ROOT_ID,
  createFolderFixture,
  describeDiff,
  liveRemote,
  localDirectories,
  remoteDirectories,
} from "../test-support/folder-fixture.js";

// Folders that hold files are not listed by Drive state; only empty folders
// are. These scenarios cover how a remote deletion, rename or move of such
// trees — with and without empty folders inside — is applied on another
// device, and that the leftovers are never read back as local additions.

const SCENARIOS = [
  {
    name: "remote delete of a folder holding files, a nested empty folder and an all-empty branch",
    tree: ["keep.txt", "docs/a.txt", "docs/sub/b.txt", "docs/sub/empty/", "docs/hollow/deep/"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("docs"), requestBody: { trashed: true } }),
  },
  {
    name: "remote delete of a folder that holds only empty folders",
    tree: ["keep.txt", "docs/sub/"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("docs"), requestBody: { trashed: true } }),
  },
  {
    name: "remote delete of an empty folder inside a populated folder",
    tree: ["docs/a.txt", "docs/empty/"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("docs/empty"), requestBody: { trashed: true } }),
  },
  {
    name: "remote rename of a folder holding files and a nested empty folder",
    tree: ["docs/a.txt", "docs/sub/empty/"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("docs"), requestBody: { name: "archive" } }),
  },
  {
    name: "remote rename of a folder that holds only empty folders",
    tree: ["keep.txt", "docs/sub/"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("docs"), requestBody: { name: "archive" } }),
  },
  {
    name: "remote rename of an empty folder",
    tree: ["keep.txt", "empty/"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("empty"), requestBody: { name: "renamed" } }),
  },
  {
    name: "remote move of a folder holding an empty folder under another folder",
    tree: ["dest/x.txt", "docs/a.txt", "docs/sub/"],
    mutate: async ({ drive, ids }) => drive.files.update({
      fileId: ids.get("docs"), addParents: ids.get("dest"), removeParents: ROOT_ID,
    }),
  },
  {
    name: "remote delete of the last file in a subfolder leaves an empty folder on Drive",
    tree: ["docs/b.txt", "docs/sub/x.txt"],
    mutate: async ({ drive, ids }) => drive.files.update({ fileId: ids.get("docs/sub/x.txt"), requestBody: { trashed: true } }),
  },
];

// The other direction: what the user does locally is still a local change, and
// is pushed exactly once — the fix must not hide genuine local additions.
const LOCAL_SCENARIOS = [
  {
    name: "a folder created locally is a local addition and is pushed once",
    tree: ["keep.txt"],
    mutate: async ({ device }) => fs.mkdir(path.join(device, "fresh")),
    expectLocal: ["local_added fresh"],
  },
  {
    name: "a branch of nested empty folders created locally is pushed",
    tree: ["keep.txt"],
    mutate: async ({ device }) => fs.mkdir(path.join(device, "fresh", "inner"), { recursive: true }),
    expectLocal: ["local_added fresh", "local_added fresh/inner"],
  },
  {
    name: "an all-empty branch deleted locally is deleted on Drive",
    tree: ["keep.txt", "docs/a.txt", "docs/hollow/deep/"],
    mutate: async ({ device }) => fs.rm(path.join(device, "docs", "hollow"), { recursive: true }),
    expectLocal: ["local_deleted docs/hollow"],
  },
  {
    name: "an empty folder renamed locally is renamed on Drive",
    tree: ["keep.txt", "empty/"],
    mutate: async ({ device }) => fs.rename(path.join(device, "empty"), path.join(device, "renamed")),
    expectLocal: ["local_renamed renamed"],
  },
];

for (const scenario of LOCAL_SCENARIOS) {
  test(`empty folders (local side): ${scenario.name}`, async (t) => {
    const fixture = await createFolderFixture(t, scenario.tree);
    const { device, repo, refreshRemote } = fixture;

    await scenario.mutate(fixture);
    const before = await repo.loadState({ useCache: false });
    assert.deepEqual(
      before.diff.localChanges.map((change) => `${change.changeType} ${change.path}`).sort(),
      scenario.expectLocal.slice().sort(),
      describeDiff(before.diff)
    );
    assert.deepEqual(before.diff.remoteChanges, [], describeDiff(before.diff));

    repo.stageChanges(before.diff.localChanges);
    assert.deepEqual((await repo.commitStaged({ message: "push" })).errors, []);

    // Ask Drive itself rather than the memo: this asserts what really exists.
    assert.deepEqual(
      await localDirectories(device),
      remoteDirectories(await refreshRemote()),
      "Drive must end up with the same folders as the local tree"
    );
    const after = await repo.loadState({ useCache: false });
    assert.equal(after.diff.isClean, true, `diff must be clean after the push: ${describeDiff(after.diff)}`);
  });
}

for (const scenario of SCENARIOS) {
  test(`empty folders: ${scenario.name}`, async (t) => {
    const fixture = await createFolderFixture(t, scenario.tree);
    const { drive, device, repo, refreshRemote } = fixture;

    await scenario.mutate(fixture);
    const remoteAfterMutation = await refreshRemote();
    const driveBeforePull = liveRemote(drive);

    const before = await repo.loadState({ useCache: false });
    assert.deepEqual(
      before.diff.localChanges.map((change) => `${change.changeType} ${change.path}`),
      [],
      `a remote-only change must not appear as a local change before pulling: ${describeDiff(before.diff)}`
    );
    assert.ok(before.diff.remoteChanges.length > 0, "the remote change must be visible");

    repo.stageChanges(before.diff.remoteChanges);
    assert.deepEqual((await repo.commitStaged({ message: "pull" })).errors, []);

    assert.deepEqual(
      await localDirectories(device),
      remoteDirectories(remoteAfterMutation),
      "local directories must match the folders that still exist on Drive"
    );

    const after = await repo.loadState({ useCache: false });
    assert.equal(after.diff.isClean, true, `diff must be clean after the pull: ${describeDiff(after.diff)}`);
    assert.deepEqual(liveRemote(drive), driveBeforePull, "pulling must not change Drive");
  });
}
