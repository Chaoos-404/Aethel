import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { AethelTui } from "../src/tui/app.js";
import { mountInTerminal } from "../test-support/fake-terminal.js";
import { createTempDirectory } from "../test-support/workspace.js";

const h = React.createElement;

function fakeRepo(root, localDirectory) {
  return {
    root,
    getSnapshot: () => null, // no baseline: the panel opens without touching Drive
    listLocalEntries: async () => [],
    getAccountInfo: async () => ({ email: "me@example.com", usage: "1 GB", limit: "15 GB" }),
    listRemoteFiles: async () => [],
    localDirectory,
  };
}

function mountApp(t, { root, ...props } = {}) {
  const cwd = createTempDirectory(t, "aethel-tui-sync-");
  const originalCwd = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(originalCwd));
  return mountInTerminal(
    t,
    h(AethelTui, { repo: fakeRepo(root, cwd), ...props })
  );
}

test("w opens the sync panel and Esc returns to the file browser", async (t) => {
  const screen = mountApp(t, { root: "/work/demo" });
  await screen.waitFor((f) => f.includes("Loaded 0 Drive item(s)"), "browser is ready");

  await screen.press("w");
  await screen.waitFor((f) => f.includes("Aethel Sync  demo"), "sync panel opens");
  await screen.waitFor((f) => f.includes("No baseline yet"), "first sync explains itself");

  await screen.press("\u001b");
  await screen.waitFor((f) => f.includes("Closed auto-sync panel."), "back in the browser");
});

test("keys typed in the sync panel do not reach the file browser", async (t) => {
  const screen = mountApp(t, { root: "/work/demo" });
  await screen.waitFor((f) => f.includes("Loaded 0 Drive item(s)"), "browser is ready");
  await screen.press("w");
  await screen.waitFor((f) => f.includes("Aethel Sync"), "sync panel opens");

  // In the browser these would switch panes, open the command list or quit.
  for (const key of ["\t", "f", "?", "x"]) await screen.press(key);

  assert.match(screen.frame(), /Aethel Sync/);
  assert.doesNotMatch(screen.frame(), /Aethel Commands|Keyboard Shortcuts/);
});

test("w explains that auto-sync needs a workspace when there is none", async (t) => {
  const screen = mountApp(t, { root: null });
  await screen.waitFor((f) => f.includes("Loaded 0 Drive item(s)"), "browser is ready");

  await screen.press("w");

  await screen.waitFor((f) => f.includes("needs an Aethel workspace"), "explanation is shown");
  assert.doesNotMatch(screen.frame(), /Aethel Sync/);
});

test("initialView sync opens the panel straight away and survives the background load", async (t) => {
  const screen = mountApp(t, { root: "/work/demo", initialView: "sync" });

  await screen.waitFor((f) => f.includes("Aethel Sync  demo"), "sync panel is first");
  // Give the browser's background load time to finish; it must not replace the panel.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(screen.frame(), /Aethel Sync/);
});
