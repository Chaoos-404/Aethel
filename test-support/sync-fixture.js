import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { initWorkspace, writeSnapshot } from "../src/core/config.js";
import { getRemoteState } from "../src/core/drive-api.js";
import { Repository } from "../src/core/repository.js";
import { buildSnapshot, scanLocal } from "../src/core/snapshot.js";
import { createFakeDrive, folder } from "./fake-drive.js";
import { createTempDirectory } from "./workspace.js";

export const ROOT_ID = "project";
export const MEMO_OPTIONS = { remoteMemoMode: "force", fetchMode: "scoped" };

export async function remoteWrite(drive, name, content, fileId = null) {
  const media = { body: Readable.from([content]) };
  if (fileId) {
    await drive.files.update({ fileId, media });
    return fileId;
  }
  const created = await drive.files.create({
    requestBody: { name, parents: [ROOT_ID] },
    media,
  });
  return created.data.id;
}

/** A workspace and a Drive that agree on `shared.txt` and `fight.txt`. */
export async function createSyncFixture(t, { baseline = true } = {}) {
  const root = createTempDirectory(t, "aethel-auto-sync-");
  const drive = createFakeDrive([folder(ROOT_ID, "Project", "root", "2026-04-04T10:00:00.000Z")]);
  const ids = {
    shared: await remoteWrite(drive, "shared.txt", "shared"),
    fight: await remoteWrite(drive, "fight.txt", "original"),
  };

  initWorkspace(root, ROOT_ID);
  await fs.writeFile(path.join(root, "shared.txt"), "shared");
  await fs.writeFile(path.join(root, "fight.txt"), "original");
  if (baseline) {
    const initial = await getRemoteState(drive, ROOT_ID, null, MEMO_OPTIONS);
    writeSnapshot(root, buildSnapshot(initial.files, await scanLocal(root), "baseline"));
  }

  const repo = new Repository(root, { drive });
  repo._remoteFetchOptions = () => MEMO_OPTIONS;
  return { root, drive, repo, ids };
}

/** Both sides edit fight.txt; each side also adds an unrelated file. */
export async function diverge({ root, drive, ids }) {
  await fs.writeFile(path.join(root, "fight.txt"), "local edit");
  await fs.writeFile(path.join(root, "new-local.txt"), "from here");
  await remoteWrite(drive, "fight.txt", "remote edit", ids.fight);
  await remoteWrite(drive, "new-remote.txt", "from drive");
}

