import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTestWorkspace } from "../test-support/workspace.js";
import { describeActiveSync, readWorkspaceLock, withWorkspaceLock } from "../src/core/workspace-lock.js";

test("workspace lock excludes another process and releases after failure", async t => {
  const root = createTestWorkspace(t);
  const moduleUrl = new URL("../src/core/workspace-lock.js", import.meta.url).href;
  await assert.rejects(withWorkspaceLock(root, async () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { withWorkspaceLock } from ${JSON.stringify(moduleUrl)};
      try { await withWorkspaceLock(${JSON.stringify(root)}, () => {}); process.exitCode = 9; }
      catch (error) { if (error.code !== 'WORKSPACE_LOCKED') throw error; }
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    throw new Error("test failure");
  }), /test failure/);
  await withWorkspaceLock(root, async () => {});
  assert.equal(fs.existsSync(path.join(root, ".aethel", "sync.lock")), false);
});

test("readWorkspaceLock reports the running sync and is null when the workspace is free", async t => {
  const root = createTestWorkspace(t, { prefix: "aethel-lock-" });
  assert.equal(readWorkspaceLock(root), null);

  await withWorkspaceLock(root, async () => {
    const lock = readWorkspaceLock(root);
    assert.equal(lock.pid, process.pid);
    assert.ok(Date.parse(lock.startedAt) > 0);
  });

  assert.equal(readWorkspaceLock(root), null);
});

test("readWorkspaceLock treats a lock whose details are not written yet as held", t => {
  const root = createTestWorkspace(t, { prefix: "aethel-lock-" });
  fs.writeFileSync(path.join(root, ".aethel", "sync.lock"), "");
  assert.deepEqual(readWorkspaceLock(root), {});
  assert.match(describeActiveSync({}), /^Notice: a sync is running in this workspace\. /);
});

test("describeActiveSync names the owner and warns the listing may be half-applied", () => {
  const message = describeActiveSync({ pid: 4242, host: "laptop", startedAt: "2026-10-10T09:00:00.000Z" });
  assert.match(message, /\(pid 4242, host laptop, started 2026-10-10T09:00:00\.000Z\)/);
  assert.match(message, /half-applied/);
  assert.match(message, /sync\.lock/);
});
