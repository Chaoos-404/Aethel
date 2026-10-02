import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { initWorkspace, writeSnapshot } from "../src/core/config.js";
import { getRemoteState } from "../src/core/drive-api.js";
import { Repository } from "../src/core/repository.js";
import { scanLocal, buildSnapshot } from "../src/core/snapshot.js";
import { createTempDirectory } from "../test-support/workspace.js";
import { createFakeDrive, folder, FOLDER_MIME } from "../test-support/fake-drive.js";

const ROOT_ID = "project";
const MEMO_OPTIONS = { remoteMemoMode: "force", fetchMode: "scoped" };
const SCENARIOS = [
  { kind: "file", action: "rename", target: "renamed.txt" },
  { kind: "file", action: "delete" },
  { kind: "folder", action: "rename", target: "archive" },
  { kind: "folder", action: "delete" },
  { kind: "file", action: "move", target: "destination/original.txt" },
  { kind: "folder", action: "move", target: "destination/docs" },
];

async function createTwoDeviceFixture(t, scenario) {
  const root = createTempDirectory(t, "aethel-two-devices-");
  const deviceA = path.join(root, "device-a");
  const deviceB = path.join(root, "device-b");
  const drive = createFakeDrive([
    folder(ROOT_ID, "Project", "root", "2026-04-04T10:00:00.000Z"),
  ]);
  const isFolder = scenario.kind === "folder";
  const oldPath = isFolder ? "docs/original.txt" : "original.txt";
  const newPath = scenario.target
    ? (isFolder ? `${scenario.target}/original.txt` : scenario.target)
    : null;

  async function createFolder(name) {
    const response = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [ROOT_ID] },
    });
    return response.data.id;
  }

  const destinationId = scenario.action === "move" ? await createFolder("destination") : null;
  const parentId = isFolder ? await createFolder("docs") : ROOT_ID;
  const created = await drive.files.create({
    requestBody: { name: "original.txt", parents: [parentId] },
    media: { body: Readable.from(["original"]) },
  });
  const readRemote = () => getRemoteState(drive, ROOT_ID, null, MEMO_OPTIONS);
  const initial = await readRemote();

  for (const device of [deviceA, deviceB]) {
    await fs.mkdir(device);
    initWorkspace(device, ROOT_ID);
    await fs.mkdir(path.dirname(path.join(device, oldPath)), { recursive: true });
    await fs.writeFile(path.join(device, oldPath), "original");
    if (destinationId) await fs.mkdir(path.join(device, "destination"));
    writeSnapshot(device, buildSnapshot(initial.files, await scanLocal(device), "shared baseline"));
  }

  const repoA = new Repository(deviceA, { drive });
  const repoB = new Repository(deviceB, { drive });
  repoA._remoteFetchOptions = repoB._remoteFetchOptions = () => MEMO_OPTIONS;
  return {
    drive, deviceA, deviceB, repoA, repoB, readRemote, oldPath, newPath,
    source: isFolder ? "docs" : oldPath,
    targetId: isFolder ? parentId : created.data.id,
    destinationId,
  };
}

async function mutateDeviceA(fixture, scenario) {
  const { drive, deviceA, source, targetId, destinationId } = fixture;
  const sourcePath = path.join(deviceA, source);
  if (scenario.action === "delete") {
    await fs.rm(sourcePath, { recursive: true });
    await drive.files.update({ fileId: targetId, requestBody: { trashed: true } });
    return;
  }

  await fs.rename(sourcePath, path.join(deviceA, scenario.target));
  await drive.files.update(scenario.action === "move"
    ? { fileId: targetId, addParents: destinationId, removeParents: ROOT_ID }
    : { fileId: targetId, requestBody: { name: scenario.target } });
}

function assertRemoteMutation(state, { oldPath, newPath }) {
  assert.equal(state.files.some(entry => entry.path === oldPath), false);
  if (newPath) assert.ok(state.files.some(entry => entry.path === newPath));
}

for (const scenario of SCENARIOS) {
  test(`two devices: ${scenario.kind} ${scenario.action} on A remains a remote change after B pushes an unrelated file`, async t => {
    const fixture = await createTwoDeviceFixture(t, scenario);
    const { deviceB, repoA, repoB, readRemote, oldPath, newPath } = fixture;

    // Warm B's local cache, then exercise both stale and refreshed Drive memos.
    await repoB.getRemoteState({ useCache: false });
    await mutateDeviceA(fixture, scenario);
    assertRemoteMutation(await readRemote(), fixture);
    await repoA.saveSnapshot("A changed the tree");
    assertRemoteMutation(await readRemote(), fixture);

    // An unrelated push must not acknowledge the change B has not applied.
    await fs.writeFile(path.join(deviceB, "independent.txt"), "B work");
    const beforePush = await repoB.loadState();
    assert.ok(beforePush.diff.remoteChanges.length > 0, "B must refresh its warm local cache");
    repoB.stageChanges(beforePush.diff.localChanges.filter(change => change.path === "independent.txt"));
    assert.deepEqual((await repoB.commitStaged({ message: "B independent work" })).errors, []);

    const afterPush = await repoB.loadState({ useCache: false });
    assert.equal(
      afterPush.diff.localChanges.some(change => change.path === oldPath || change.path === "docs"),
      false,
      JSON.stringify(afterPush.diff.changes.map(change => ({ type: change.changeType, path: change.path })))
    );
    assert.ok(afterPush.diff.remoteChanges.length > 0, "A's change must remain pending on B");

    repoB.stageChanges(afterPush.diff.remoteChanges);
    assert.deepEqual((await repoB.commitStaged({ message: "B accepts A changes" })).errors, []);
    await assert.rejects(fs.access(path.join(deviceB, oldPath)), { code: "ENOENT" });
    if (newPath) assert.equal(await fs.readFile(path.join(deviceB, newPath), "utf8"), "original");
    assert.equal((await repoB.loadState({ useCache: false })).diff.isClean, true);
    assertRemoteMutation(await readRemote(), fixture);
  });
}
