import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React from "react";
import {
  describeSideLine,
  formatClock,
  outcomeLogLines,
  SyncView,
  wrapText,
} from "../src/tui/sync-view.js";
import { mountInTerminal } from "../test-support/fake-terminal.js";
import { createSyncFixture, diverge } from "../test-support/sync-fixture.js";

const h = React.createElement;

function outcome(overrides = {}) {
  return {
    skipped: null,
    pulled: 0,
    pushed: 0,
    held: 0,
    conflicts: [],
    resolving: 0,
    packConflicts: 0,
    errors: [],
    summary: "",
    baselineSaved: false,
    ...overrides,
  };
}

function conflict(name, { local = true, remote = true } = {}) {
  return {
    path: name,
    localMeta: local
      ? { md5: "aaaaaaaabbbb", size: 12, modifiedTime: "2026-02-01T10:00:00Z" }
      : null,
    remoteMeta: remote
      ? { md5Checksum: "ccccccccdddd", size: "2048", modifiedTime: "2026-02-02T11:30:00Z" }
      : null,
  };
}

/** Mount the panel on a fake terminal; `frame()` is the latest screen. */
function mount(t, props) {
  const staged = [];
  const repo = {
    root: "/work/demo",
    stageConflictResolution: (change, strategy) => staged.push([change.path, strategy]),
  };
  let onCloseCalls = 0;
  const terminal = mountInTerminal(
    t,
    h(SyncView, {
      repo,
      width: 110,
      height: 30,
      watchLocal: false,
      onClose: () => { onCloseCalls += 1; },
      ...props,
    })
  );
  return { ...terminal, staged, closed: () => onCloseCalls };
}

test("the panel syncs on open and lists the conflicts it could not resolve", async (t) => {
  const cycles = [];
  const screen = mount(t, {
    runCycle: async (repo, options) => {
      cycles.push(options);
      return outcome({
        pulled: 2,
        pushed: 1,
        summary: "2 downloaded, 1 uploaded",
        conflicts: [conflict("notes/todo.md"), conflict("report.docx")],
      });
    },
  });

  await screen.waitFor((f) => f.includes("Conflicts (2)"), "conflicts are listed");
  const frame = screen.frame();

  assert.equal(cycles.length, 1);
  assert.match(frame, /Aethel Sync {2}demo/);
  assert.match(frame, /AUTO every 60s/);
  assert.match(frame, /!! notes\/todo\.md/);
  assert.match(frame, /!! report\.docx/);
  assert.match(frame, /↓2 ↑1 {2}2 downloaded, 1 uploaded/);
  assert.match(frame, /2 conflict\(s\) need a decision/);
  assert.match(frame, /both sides changed/);
  assert.match(frame, /Local {3}12 B {2}2026-02-01 10:00/);
  assert.match(frame, /Drive {3}2\.0 KB {2}2026-02-02 11:30/);
});

test("r keeps the Drive copy of the selected conflict and syncs again", async (t) => {
  let cycles = 0;
  const screen = mount(t, {
    runCycle: async () => {
      cycles += 1;
      return cycles === 1
        ? outcome({ conflicts: [conflict("a.txt"), conflict("b.txt")] })
        : outcome({ pulled: 1, summary: "1 downloaded" });
    },
  });
  await screen.waitFor((f) => f.includes("Conflicts (2)"), "conflicts are listed");

  await screen.press("j");
  await screen.waitFor((f) => f.includes("!! b.txt"), "cursor moved");
  await screen.press("r");

  await screen.waitFor((f) => f.includes("Conflicts (0)"), "resolved conflicts leave the list");
  assert.deepEqual(screen.staged, [["b.txt", "theirs"]]);
  assert.equal(cycles, 2, "the resolution is applied right away");
});

test("a choice that needs a side that is gone is refused", async (t) => {
  const screen = mount(t, {
    runCycle: async () => outcome({ conflicts: [conflict("gone.txt", { remote: false })] }),
  });
  await screen.waitFor((f) => f.includes("Conflicts (1)"), "conflict is listed");
  assert.match(screen.frame(), /Drive {3}deleted/);

  await screen.press("r");

  await screen.waitFor((f) => f.includes("that side does not exist"), "refusal is shown");
  assert.deepEqual(screen.staged, []);
});

test("R asks before keeping the Drive copy of every conflict", async (t) => {
  let cycles = 0;
  const screen = mount(t, {
    runCycle: async () => {
      cycles += 1;
      return cycles === 1
        ? outcome({ conflicts: [conflict("a.txt"), conflict("b.txt")] })
        : outcome();
    },
  });
  await screen.waitFor((f) => f.includes("Conflicts (2)"), "conflicts are listed");

  await screen.press("R");
  await screen.waitFor((f) => f.includes("keep remote for all 2 conflict(s)?"), "confirmation");
  assert.deepEqual(screen.staged, [], "nothing is staged before confirming");

  await screen.press("n");
  await screen.waitFor((f) => f.includes("Cancelled."), "cancelled");
  assert.deepEqual(screen.staged, []);

  await screen.press("R");
  await screen.waitFor((f) => f.includes("for all 2 conflict(s)?"), "confirmation again");
  await screen.press("y");
  await screen.waitFor((f) => f.includes("Conflicts (0)"), "all resolved");
  assert.deepEqual(screen.staged, [["a.txt", "theirs"], ["b.txt", "theirs"]]);
});

test("p pauses automatic syncing and s still syncs on demand", async (t) => {
  let cycles = 0;
  const screen = mount(t, {
    runCycle: async () => {
      cycles += 1;
      return outcome();
    },
  });
  await screen.waitFor((f) => f.includes("Up to date"), "first cycle finished");

  await screen.press("p");
  await screen.waitFor((f) => f.includes("PAUSED"), "paused");
  await screen.press("s");
  await screen.waitFor(() => cycles === 2, "manual sync ran");
});

test("a failing cycle is reported instead of crashing the panel", async (t) => {
  const screen = mount(t, {
    runCycle: async () => {
      throw new Error("disk full");
    },
  });

  await screen.waitFor((f) => f.includes("Sync failed: disk full"), "error is logged");
  assert.match(screen.frame(), /had problems/);
});

test("Esc closes the panel only when no sync is running", async (t) => {
  let release;
  const screen = mount(t, {
    runCycle: () => new Promise((resolve) => { release = () => resolve(outcome()); }),
  });
  await screen.waitFor((f) => f.includes("Scanning"), "cycle is running");

  await screen.press("\u001b");
  await screen.waitFor((f) => f.includes("Close the panel when it finishes"), "refused while running");
  assert.equal(screen.closed(), 0);

  release();
  await screen.waitFor((f) => f.includes("Up to date"), "cycle finished");
  // Ink waits briefly to tell a lone Escape from an escape sequence.
  await screen.press("\u001b");
  await screen.waitFor(() => screen.closed() === 1, "panel closed");
});

// ── pure helpers ──

test("outcomeLogLines explains the first-sync case", () => {
  const [line] = outcomeLogLines(outcome({ skipped: "no-baseline" }));
  assert.equal(line.level, "warn");
  assert.match(line.text, /aethel pull --all/);
});

test("outcomeLogLines reports new conflicts once and surfaces errors", () => {
  const conflicts = [conflict("a.txt")];
  const lines = outcomeLogLines(
    outcome({ pulled: 1, conflicts, held: 2, errors: ["upload x: boom"], summary: "1 downloaded" }),
    0
  );

  assert.deepEqual(lines.map((l) => l.level), ["warn", "error", "warn", "info"]);
  assert.deepEqual(outcomeLogLines(outcome({ conflicts }), 1), []);
});

test("describeSideLine formats present and deleted sides", () => {
  assert.equal(describeSideLine("Local ", { present: false }), "Local   deleted");
  assert.equal(
    describeSideLine("Drive ", {
      present: true, size: 1536, modifiedTime: "2026-02-02T11:30:00Z", md5: "abcdef123456", isFolder: false,
    }),
    "Drive   1.5 KB  2026-02-02 11:30  md5 abcdef12"
  );
});

test("formatClock zero-pads", () => {
  assert.equal(formatClock(new Date(2026, 0, 1, 3, 4, 5)), "03:04:05");
});

test("wrapText breaks on spaces and hard-wraps unbroken words", () => {
  assert.deepEqual(wrapText("short", 10), ["short"]);
  assert.deepEqual(wrapText("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("", 4), [""]);
});

test("a long error wraps in the activity log instead of being cut off", async (t) => {
  const screen = mount(t, {
    runCycle: async () => outcome({ errors: ["upload reports/2026/quarterly-summary.xlsx: quota exceeded"] }),
  });

  await screen.waitFor((f) => f.includes("quota exceeded"), "the end of the message is visible");
  // The path hard-wraps across rows; reading the rows back must give the whole message.
  const activityColumn = screen.frame().split("\n").map((row) => row.split("││")[0]).join("");
  const flattened = activityColumn.replace(/[│\s]+/g, "");
  assert.ok(flattened.includes("uploadreports/2026/quarterly-summary.xlsx:quotaexceeded"));
});

// ── end to end: real engine, real repository, fake Drive ──

test("the panel syncs a diverged workspace and resolves its conflict from the keyboard", async (t) => {
  const fixture = await createSyncFixture(t);
  await diverge(fixture);
  const screen = mountInTerminal(
    t,
    h(SyncView, {
      repo: fixture.repo,
      width: 110,
      height: 30,
      watchLocal: false,
      onClose() {},
    })
  );

  await screen.waitFor((f) => f.includes("Conflicts (1)"), "the conflict is found");
  assert.match(screen.frame(), /!! fight\.txt/);
  assert.match(screen.frame(), /↓1 ↑1/);
  // One-sided changes went both ways; the conflict was left alone.
  assert.equal(await fs.readFile(path.join(fixture.root, "new-remote.txt"), "utf8"), "from drive");
  assert.equal(await fs.readFile(path.join(fixture.root, "fight.txt"), "utf8"), "local edit");

  await screen.press("r");

  await screen.waitFor((f) => f.includes("Conflicts (0)"), "the conflict is resolved");
  await screen.waitFor(
    () => fsSync.readFileSync(path.join(fixture.root, "fight.txt"), "utf8") === "remote edit",
    "the Drive version replaced the local file"
  );
  assert.deepEqual(fixture.repo.getStagedEntries(), []);
});
