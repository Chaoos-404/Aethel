import test from "node:test";
import assert from "node:assert/strict";
import { createProgressBar } from "../src/core/progress.js";

function createProgressFixture({ total, isTTY = false }) {
  let time = 0;
  const lines = [];
  const bar = createProgressBar("Syncing", total, {
    stream: { isTTY, write: line => lines.push(line) },
    now: () => time,
  });
  return { bar, lines, advanceTime: milliseconds => { time += milliseconds; } };
}

test("scheduled runs show throttled progress before completion", () => {
  const { bar, lines, advanceTime } = createProgressFixture({ total: 10 });

  bar.update(1);
  assert.equal(lines.length, 1);

  advanceTime(1000);
  bar.update(3);
  assert.match(lines[1], /3\/10 \(30%\)/);

  bar.done("Finished");
  assert.match(lines[2], /10\/10 \(100%\)/);
  assert.equal(lines[3], "Finished\n");
});

test("terminal progress replaces its current line", () => {
  const { bar, lines } = createProgressFixture({ total: 2, isTTY: true });

  bar.update(1);

  assert.match(lines[1], /^\r\x1b\[KSyncing.*1\/2/);
});
