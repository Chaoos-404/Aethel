import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTestWorkspace } from "../test-support/workspace.js";
import { withWorkspaceLock } from "../src/core/workspace-lock.js";

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

