import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ROOT_ID,
  createFolderFixture,
  describeDiff,
  localDirectories,
  remoteDirectories,
} from "../test-support/folder-fixture.js";

// Moving a folder under a different parent used to be a deletion of every file
// plus an upload of every file at the new path. When the baseline's files are
// all there, unchanged, at one new folder, it is a move: the Drive folder keeps
// its ID, so nothing is transferred.

function pathOnDrive(drive, id) {
  const items = new Map(drive.snapshot().map((item) => [item.id, item]));
  const parts = [];
  for (let item = items.get(id); item && item.id !== ROOT_ID; item = items.get(item.parents?.[0])) {
    parts.unshift(item.name);
  }
  return parts.join("/");
}

const MOVES = [
  {
    name: "a folder moved under a new parent",
    tree: ["keep.txt", "courses/ee/a.txt", "courses/ee/sub/b.txt", "courses/other.txt"],
    mutate: async (device) => {
      await fs.mkdir(path.join(device, "archive"));
      await fs.rename(path.join(device, "courses", "ee"), path.join(device, "archive", "ee"));
    },
    expectLocal: ["local_renamed archive/ee"],
    kept: {
      "courses/ee/a.txt": "archive/ee/a.txt",
      "courses/ee/sub/b.txt": "archive/ee/sub/b.txt",
      "courses/other.txt": "courses/other.txt",
    },
  },
  {
    name: "a folder moved into a folder that is already tracked",
    tree: ["archive/old.txt", "courses/ee/a.txt", "courses/other.txt"],
    mutate: async (device) => {
      await fs.rename(path.join(device, "courses", "ee"), path.join(device, "archive", "ee"));
    },
    expectLocal: ["local_renamed archive/ee"],
    kept: { "courses/ee/a.txt": "archive/ee/a.txt", "archive/old.txt": "archive/old.txt" },
  },
  {
    name: "a folder moved and renamed at once",
    tree: ["keep.txt", "courses/ee/a.txt", "courses/other.txt"],
    mutate: async (device) => {
      await fs.mkdir(path.join(device, "archive", "2026"), { recursive: true });
      await fs.rename(path.join(device, "courses", "ee"), path.join(device, "archive", "2026", "electronics"));
    },
    expectLocal: ["local_renamed archive/2026/electronics"],
    kept: { "courses/ee/a.txt": "archive/2026/electronics/a.txt" },
  },
  {
    name: "the last folder of a parent, which stays behind empty",
    tree: ["keep.txt", "courses/ee/a.txt", "courses/ee/b.txt"],
    mutate: async (device) => {
      await fs.mkdir(path.join(device, "archive"));
      await fs.rename(path.join(device, "courses", "ee"), path.join(device, "archive", "ee"));
    },
    expectLocal: ["local_renamed archive/ee"],
    kept: { "courses/ee/a.txt": "archive/ee/a.txt", "courses/ee/b.txt": "archive/ee/b.txt" },
  },
];

for (const scenario of MOVES) {
  test(`cross-parent move: ${scenario.name} is a rename on Drive with nothing transferred`, async (t) => {
    const fixture = await createFolderFixture(t, scenario.tree);
    const { drive, device, ids, repo, refreshRemote } = fixture;

    await scenario.mutate(device);
    const before = await repo.loadState({ useCache: false });
    assert.deepEqual(
      before.diff.localChanges.map((change) => `${change.changeType} ${change.path}`).sort(),
      scenario.expectLocal,
      describeDiff(before.diff)
    );
    assert.deepEqual(before.diff.remoteChanges, [], describeDiff(before.diff));

    repo.stageChanges(before.diff.localChanges);
    const result = await repo.commitStaged({ message: "push" });
    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 0, "no file may be uploaded again");
    assert.equal(result.deletedRemote, 0, "no file may be trashed");

    for (const [from, to] of Object.entries(scenario.kept)) {
      const item = drive.snapshot().find((candidate) => candidate.id === ids.get(from));
      assert.ok(item && !item.trashed, `${from} must keep its Drive file`);
      assert.equal(pathOnDrive(drive, ids.get(from)), to);
    }
    assert.deepEqual(
      await localDirectories(device),
      remoteDirectories(await refreshRemote()),
      "Drive must end up with the same folders as the local tree"
    );
    const after = await repo.loadState({ useCache: false });
    assert.equal(after.diff.isClean, true, `diff must be clean after the push: ${describeDiff(after.diff)}`);
  });
}

test("cross-parent move: a folder edited while moving is uploaded, not renamed", async (t) => {
  const fixture = await createFolderFixture(t, ["keep.txt", "courses/ee/a.txt", "courses/ee/b.txt", "courses/other.txt"]);
  const { drive, device, repo, refreshRemote } = fixture;

  await fs.mkdir(path.join(device, "archive"));
  await fs.rename(path.join(device, "courses", "ee"), path.join(device, "archive", "ee"));
  await fs.writeFile(path.join(device, "archive", "ee", "a.txt"), "edited while moving");

  const before = await repo.loadState({ useCache: false });
  assert.ok(
    !before.diff.localChanges.some((change) => change.changeType === "local_renamed" && change.path === "archive/ee"),
    describeDiff(before.diff)
  );

  repo.stageChanges(before.diff.localChanges);
  assert.deepEqual((await repo.commitStaged({ message: "push" })).errors, []);

  const uploaded = drive.snapshot().find(
    (item) => !item.trashed && pathOnDrive(drive, item.id) === "archive/ee/a.txt"
  );
  assert.equal(uploaded?._body, "edited while moving", "the edit must reach Drive");
  assert.deepEqual(await localDirectories(device), remoteDirectories(await refreshRemote()));
  const after = await repo.loadState({ useCache: false });
  assert.equal(after.diff.isClean, true, `diff must be clean after the push: ${describeDiff(after.diff)}`);
});
