import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { initWorkspace, writeSnapshot } from "../src/core/config.js";
import { getRemoteState, resetFolderLookupCache } from "../src/core/drive-api.js";
import { Repository } from "../src/core/repository.js";
import { scanLocal, buildSnapshot } from "../src/core/snapshot.js";
import { createTempDirectory } from "./workspace.js";
import { createFakeDrive, folder, FOLDER_MIME } from "./fake-drive.js";

export const ROOT_ID = "project";
const MEMO_OPTIONS = { remoteMemoMode: "force", fetchMode: "scoped" };

/**
 * One fake Drive plus one device that is fully in sync with it.
 *
 * `tree` entries ending in "/" are explicit empty folders, the rest files whose
 * content is `content of <path>`. `localOnly` files exist on the device and in
 * its baseline but never reached Drive — saveSnapshot() records every scanned
 * file whether or not its upload succeeded.
 */
export async function createFolderFixture(t, tree, { localOnly = [] } = {}) {
  // Folder IDs are memoised per path for the life of the process; every
  // scenario builds its own Drive, so a leftover ID would point at a folder
  // that only exists in a previous scenario's Drive.
  resetFolderLookupCache();
  const root = createTempDirectory(t, "aethel-folder-fixture-");
  const drive = createFakeDrive([folder(ROOT_ID, "Project", "root", "2026-04-04T10:00:00.000Z")]);
  const ids = new Map([["", ROOT_ID]]);

  async function ensureFolder(folderPath) {
    if (ids.has(folderPath)) return ids.get(folderPath);
    const parent = await ensureFolder(path.posix.dirname(folderPath) === "." ? "" : path.posix.dirname(folderPath));
    const created = await drive.files.create({
      requestBody: { name: path.posix.basename(folderPath), mimeType: FOLDER_MIME, parents: [parent] },
    });
    ids.set(folderPath, created.data.id);
    return created.data.id;
  }

  for (const entry of tree) {
    if (entry.endsWith("/")) {
      await ensureFolder(entry.slice(0, -1));
      continue;
    }
    const dir = path.posix.dirname(entry);
    const parent = await ensureFolder(dir === "." ? "" : dir);
    const created = await drive.files.create({
      requestBody: { name: path.posix.basename(entry), parents: [parent] },
      media: { body: Readable.from([`content of ${entry}`]) },
    });
    ids.set(entry, created.data.id);
  }

  const initial = await getRemoteState(drive, ROOT_ID, null, MEMO_OPTIONS);
  const device = path.join(root, "device-b");
  await fs.mkdir(device);
  initWorkspace(device, ROOT_ID);
  for (const entry of [...tree, ...localOnly]) {
    const abs = path.join(device, ...entry.split("/"));
    if (entry.endsWith("/")) {
      await fs.mkdir(abs, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `content of ${entry}`);
    }
  }
  writeSnapshot(device, buildSnapshot(initial.files, await scanLocal(device), "shared baseline"));

  const repo = new Repository(device, { drive });
  repo._remoteFetchOptions = () => MEMO_OPTIONS;
  /** Drive's real listing, bypassing the memo. */
  const refreshRemote = () =>
    getRemoteState(drive, ROOT_ID, null, { ...MEMO_OPTIONS, refreshRemoteMemo: true });
  return { drive, device, repo, ids, refreshRemote };
}

export async function localDirectories(device) {
  const found = [];
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".aethel") continue;
      if (!entry.isDirectory()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(relative);
      await walk(path.join(current, entry.name), relative);
    }
  }
  await walk(device, "");
  return found.sort();
}

/** Every folder Drive has: listed empty folders plus the ancestors of all entries. */
export function remoteDirectories(state) {
  const dirs = new Set();
  for (const entry of state.files) {
    if (entry.isFolder) dirs.add(entry.path);
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

export function liveRemote(drive) {
  return drive.snapshot().filter((item) => !item.trashed).map((item) => `${item.id}:${item.name}:${item.parents}`);
}

export function describeDiff(diff) {
  return JSON.stringify(diff.changes.map((change) => `${change.changeType} ${change.path}${change.sourcePath ? ` <- ${change.sourcePath}` : ""}`));
}
