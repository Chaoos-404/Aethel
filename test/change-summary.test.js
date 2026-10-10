import test from "node:test";
import assert from "node:assert/strict";
import {
  driveOnlyEmptyFolderHint,
  summarizeChanges,
  summarizeStagedEntries,
} from "../src/core/change-summary.js";

function change(path, shortStatus = "ML", description = "modified locally") {
  return { path, shortStatus, description };
}

function staged(path, action = "delete_local") {
  return { path, action };
}

test("summarizeChanges collapses multiple changes with the same parent folder", () => {
  const entries = summarizeChanges([
    change("docs/a.md"),
    change("docs/b.md"),
    change("notes/today.md"),
  ]);

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      shortStatus: entry.shortStatus,
      description: entry.description,
      count: entry.count,
    })),
    [
      {
        kind: "group",
        path: "docs/",
        shortStatus: "ML",
        description: "2 changes: modified locally",
        count: 2,
      },
      {
        kind: "change",
        path: "notes/today.md",
        shortStatus: "ML",
        description: "modified locally",
        count: 1,
      },
    ]
  );
});

test("summarizeChanges keeps root-level changes explicit", () => {
  const entries = summarizeChanges([
    change("a.md"),
    change("b.md"),
  ]);

  assert.deepEqual(entries.map((entry) => entry.path), ["a.md", "b.md"]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["change", "change"]);
});

test("summarizeChanges marks grouped mixed change statuses", () => {
  const entries = summarizeChanges([
    change("docs/old.md", "-L", "deleted locally"),
    change("docs/new.md", "+L", "new locally"),
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "docs/");
  assert.equal(entries[0].shortStatus, "..");
  assert.equal(entries[0].description, "2 changes");
});

test("summarizeChanges detail mode returns every file-level change", () => {
  const entries = summarizeChanges([
    change("docs/a.md"),
    change("docs/b.md"),
  ], { detail: true });

  assert.deepEqual(entries.map((entry) => entry.path), ["docs/a.md", "docs/b.md"]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["change", "change"]);
});

test("summarizeStagedEntries collapses large repeated directory deletions", () => {
  const entries = summarizeStagedEntries([
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab01/Exercise/00_TESTBED"),
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab01/Exercise/01_RTL"),
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab01/Practice/00_TESTBED"),
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab02/Exercise/00_TESTBED"),
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab02/Exercise/01_RTL"),
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab03/Exercise/00_TESTBED"),
    staged("01_Courses/00_Compiler/cbc-1.0/import/sys"),
    staged("01_Courses/00_Compiler/overture/tools"),
    staged("01_Courses/03_C/AP325/.gitignore", "upload"),
  ]);

  assert.deepEqual(
    entries.map((entry) => ({
      kind: entry.kind,
      action: entry.action,
      path: entry.path,
      count: entry.count,
      description: entry.description,
    })),
    [
      {
        kind: "group",
        action: "delete_local",
        path: "01_Courses/00_Compiler/",
        count: 8,
        description: "8 changes",
      },
      {
        kind: "change",
        action: "upload",
        path: "01_Courses/03_C/AP325/.gitignore",
        count: 1,
        description: "upload",
      },
    ]
  );
});

test("summarizeStagedEntries detail mode returns every staged entry", () => {
  const entries = summarizeStagedEntries([
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab01/Exercise/00_TESTBED"),
    staged("01_Courses/00_Compiler/IC_Lab/src/Lab01/Exercise/01_RTL"),
  ], { detail: true });

  assert.deepEqual(entries.map((entry) => entry.kind), ["change", "change"]);
  assert.deepEqual(entries.map((entry) => entry.path), [
    "01_Courses/00_Compiler/IC_Lab/src/Lab01/Exercise/00_TESTBED",
    "01_Courses/00_Compiler/IC_Lab/src/Lab01/Exercise/01_RTL",
  ]);
});

test("driveOnlyEmptyFolderHint counts only empty folders that are new on Drive", () => {
  const folder = (path) => ({ path, changeType: "remote_added", remoteMeta: { isFolder: true } });
  const file = (path) => ({ path, changeType: "remote_added", remoteMeta: { isFolder: false } });

  assert.equal(driveOnlyEmptyFolderHint([file("a.txt")]), null);
  assert.equal(driveOnlyEmptyFolderHint([{ path: "gone", changeType: "local_deleted", remoteMeta: { isFolder: true } }]), null);
  assert.match(driveOnlyEmptyFolderHint([folder("docs/sub")]), /^ {2}1 of these is an empty folder that exists only on Drive\./);
  const many = driveOnlyEmptyFolderHint([folder("a"), folder("b"), file("c.txt")]);
  assert.match(many, /2 of these are empty folders that exist only on Drive/);
  assert.match(many, /aethel rm <path>.*aethel push/);
});
