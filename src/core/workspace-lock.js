import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const owners = new AsyncLocalStorage();
const lockPath = root => path.join(root, ".aethel", "sync.lock");

function lockedError(root) {
  return Object.assign(new Error(`Workspace is locked: ${lockPath(root)}. If a previous process terminated, verify that it is no longer running before removing this lock and retrying.`), { code: "WORKSPACE_LOCKED" });
}

export function assertWorkspaceWritable(root) {
  const canonical = fs.realpathSync(root);
  if (owners.getStore()?.root === canonical) return;
  if (fs.existsSync(lockPath(canonical))) throw lockedError(canonical);
}

/** Never steal a lock based on elapsed time: a slow or suspended sync may own it. */
export async function withWorkspaceLock(root, work) {
  const canonical = fs.realpathSync(root);
  if (owners.getStore()?.root === canonical) return work();
  const filename = lockPath(canonical);
  const token = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(filename, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw lockedError(canonical);
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    return await owners.run({ root: canonical, token }, work);
  } finally {
    fs.closeSync(fd);
    // Do not remove a replacement lock if an operator changed it during a run.
    let currentOwner;
    try { currentOwner = JSON.parse(fs.readFileSync(filename, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (currentOwner?.token === token) fs.unlinkSync(filename);
  }
}
