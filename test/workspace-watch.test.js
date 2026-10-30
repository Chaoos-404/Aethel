import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { watchWorkspace } from "../src/core/workspace-watch.js";
import { createTestWorkspace } from "../test-support/workspace.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Some systems (macOS) deliver events for changes made just before watching
 * started, such as this fixture's own setup. Let those arrive, then count
 * only what happens afterwards.
 */
async function openWorkspace(t, options) {
  const root = createTestWorkspace(t, { prefix: "aethel-watch-" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, "build"));
  fs.writeFileSync(path.join(root, ".aethelignore"), "build/\n*.tmp\n");

  let total = 0;
  const watcher = watchWorkspace(root, () => { total += 1; }, options);
  t.after(() => watcher.close());
  await pause(500);
  const baseline = total;

  const changes = () => total - baseline;
  return {
    root,
    watcher,
    changes,
    async settle() {
      await pause(150);
    },
    async waitForChange(message, since = 0) {
      const deadline = Date.now() + 3000;
      while (changes() === since && Date.now() < deadline) await pause(10);
      assert.ok(changes() > since, message);
    },
  };
}

test("a change in the root or a subfolder is reported", async (t) => {
  const ws = await openWorkspace(t);

  fs.writeFileSync(path.join(ws.root, "top.txt"), "x");
  await ws.waitForChange("root change");

  const before = ws.changes();
  fs.writeFileSync(path.join(ws.root, "docs", "deep.txt"), "x");
  await ws.waitForChange("subfolder change", before);
});

test("ignored folders are neither watched nor reported", async (t) => {
  const ws = await openWorkspace(t);

  // root, docs: not .aethel, node_modules (and its children) or build.
  assert.equal(ws.watcher.watched, 2);

  fs.writeFileSync(path.join(ws.root, "node_modules", "pkg", "index.js"), "x");
  fs.writeFileSync(path.join(ws.root, "build", "out.js"), "x");
  fs.writeFileSync(path.join(ws.root, "docs", "scratch.tmp"), "x");
  fs.writeFileSync(path.join(ws.root, ".aethel", "noise.json"), "x");
  await ws.settle();

  assert.equal(ws.changes(), 0);
});

test("a folder created after watching started is watched too", async (t) => {
  const ws = await openWorkspace(t);

  fs.mkdirSync(path.join(ws.root, "later"));
  await ws.waitForChange("the new folder itself is a change");
  assert.equal(ws.watcher.watched, 3);

  await ws.settle();
  const before = ws.changes();
  fs.writeFileSync(path.join(ws.root, "later", "file.txt"), "x");
  await ws.waitForChange("change inside the new folder", before);
});

test("watching stops at the directory cap and says so", async (t) => {
  const ws = await openWorkspace(t, { maxDirectories: 1 });

  assert.equal(ws.watcher.watched, 1);
  assert.equal(ws.watcher.truncated, true);
});

test("nothing is reported after close", async (t) => {
  const ws = await openWorkspace(t);
  ws.watcher.close();
  assert.equal(ws.watcher.watched, 0);

  fs.writeFileSync(path.join(ws.root, "top.txt"), "x");
  await ws.settle();

  assert.equal(ws.changes(), 0);
});
