import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRunLogger, logEvent, sanitizeLogValue, withRunLog } from "../src/core/logger.js";
import { executeStaged } from "../src/core/sync.js";
import { writeIndex } from "../src/core/config.js";
import { createTempDirectory, createTestWorkspace } from "../test-support/workspace.js";

function readLogFiles(root) {
  const dir = path.join(root, ".aethel", "logs");
  return fs.readdirSync(dir).map(name => ({
    name,
    text: fs.readFileSync(path.join(dir, name), "utf8"),
  }));
}
function parseRecords(text) {
  return text.trim().split("\n").map(line => JSON.parse(line));
}

test("logger redacts credentials, URLs and API request internals", () => {
  const error = Object.assign(new Error("Bearer sensitive-token at https://drive.test/?key=secret"), {
    config: { headers: { Authorization: "secret-header" } },
    response: { status: 403, data: "private-body" },
  });
  const value = {
    access_token: "secret-access",
    nested: { clientSecret: "secret-client" },
    message: "refresh_token=secret-refresh",
    error,
  };
  value.loop = value;
  const text = JSON.stringify(sanitizeLogValue(value));
  const secrets = [
    "sensitive-token", "secret-access", "secret-client", "secret-refresh",
    "secret-header", "private-body", "drive.test",
  ];
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(text.includes("403"));
  assert.ok(text.includes("REDACTED"));
});

test("concurrent runs remain separate with ordered events and nested shared context", async t => {
  const root = createTempDirectory(t, "aethel-log-");
  await Promise.all(["one", "two"].map(command => withRunLog(root, command, async () => {
    await new Promise(resolve => setImmediate(resolve));
    await withRunLog(root, "nested", async () => logEvent("info", "test.event", { command }));
  })));
  const files = readLogFiles(root);
  assert.equal(files.length, 2);
  const ids = new Set();
  for (const file of files) {
    assert.ok(!file.name.includes("active"));
    const events = parseRecords(file.text);
    assert.deepEqual(events.map(e => e.event), ["run.started", "test.event", "run.finished"]);
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
    assert.equal(new Set(events.map(e => e.runId)).size, 1);
    ids.add(events[0].runId);
  }
  assert.equal(ids.size, 2);
});

test("retention bounds completed files while preserving active runs", t => {
  const root = createTempDirectory(t, "aethel-log-");
  const active = createRunLogger(root, { maxFiles: 2 });
  for (let i = 0; i < 5; i++) createRunLogger(root, { maxFiles: 2 }).finish("completed");
  const files = readLogFiles(root);
  assert.equal(files.filter(f => !f.name.includes("active")).length, 2);
  assert.ok(fs.existsSync(active.path));
  active.finish("completed");
  assert.equal(readLogFiles(root).length, 2);
});

test("size limit preserves valid JSON and terminal outcome", t => {
  const root = createTempDirectory(t, "aethel-log-");
  const logger = createRunLogger(root, { maxBytes: 32768 });
  for (let i = 0; i < 100; i++) logger.log("info", "large.event", { payload: "x".repeat(2048) });
  logger.finish("completed");
  logger.finish("completed");
  const file = readLogFiles(root)[0];
  assert.ok(Buffer.byteLength(file.text) <= 32768);
  const events = parseRecords(file.text);
  assert.equal(events.filter(e => e.event === "log.limit_reached").length, 1);
  assert.equal(events.at(-1).event, "run.finished");
});

test("size limit keeps the outcome events and counts the records it dropped", t => {
  const root = createTempDirectory(t, "aethel-log-");
  const logger = createRunLogger(root, { maxBytes: 32768 });
  for (let i = 0; i < 100; i++) logger.log("info", "operation.completed", { payload: "x".repeat(2048) });
  logger.log("info", "sync.finished", { summary: "5757 uploaded", failures: 0 });
  logger.log("info", "baseline.saved", { operations: 100 });
  logger.finish("completed");
  const file = readLogFiles(root)[0];
  assert.ok(Buffer.byteLength(file.text) <= 32768);
  const events = parseRecords(file.text);
  const written = events.filter(e => e.event === "operation.completed").length;
  assert.ok(written > 0 && written < 100);
  assert.equal(events.find(e => e.event === "sync.finished").details.summary, "5757 uploaded");
  assert.equal(events.find(e => e.event === "baseline.saved").details.operations, 100);
  // Every operation record is either in the file or counted as dropped.
  assert.equal(events.at(-1).details.droppedRecords + written, 100);
});

test("a run that stays under the size limit reports no dropped records", t => {
  const root = createTempDirectory(t, "aethel-log-");
  const logger = createRunLogger(root);
  logger.log("info", "operation.completed", {});
  logger.finish("completed");
  assert.equal(parseRecords(readLogFiles(root)[0].text).at(-1).details.droppedRecords, undefined);
});

test("unwritable log destination warns once without throwing", t => {
  const root = createTempDirectory(t, "aethel-log-");
  fs.mkdirSync(path.join(root, ".aethel"));
  fs.writeFileSync(path.join(root, ".aethel", "logs"), "obstruction");
  const warnings = [];
  const logger = createRunLogger(root, { warn: message => warnings.push(message) });
  logger.log("error", "test", {});
  logger.finish("failed");
  assert.equal(warnings.length, 1);
});

test("failed runs retain their original error and log a terminal failure", async t => {
  const root = createTempDirectory(t, "aethel-log-");
  const failure = new Error("failure");
  await assert.rejects(withRunLog(root, "test", async () => { throw failure; }), e => e === failure);
  const events = parseRecords(readLogFiles(root)[0].text);
  assert.equal(events.at(-2).event, "run.error");
  assert.equal(events.at(-1).details.status, "failed");
});

test("sync logs operation failures and keeps the failed entry staged", async t => {
  const root = createTestWorkspace(t, { prefix: "aethel-log-" });
  writeIndex(root, { staged: [{ action: "unknown", path: "example.txt" }] });
  const result = await executeStaged({}, root);
  assert.equal(result.errors.length, 1);
  const events = parseRecords(readLogFiles(root)[0].text);
  const failure = events.find(e => e.event === "operation.failed");
  assert.match(failure.details.operationId, /^[a-f0-9-]{36}$/);
  assert.equal(failure.details.path, "example.txt");
  assert.equal(events.find(e => e.event === "sync.finished").details.remainingStaged, 1);
  assert.equal(events.at(-1).details.status, "incomplete");
});

test("retention removes expired completed and abandoned runs", t => {
  const root = createTempDirectory(t, "aethel-log-");
  const abandoned = createRunLogger(root);
  abandoned.finish("completed");
  fs.renameSync(path.join(root, ".aethel", "logs", `${abandoned.runId}.jsonl`), abandoned.path);
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(abandoned.path, old, old);
  const completed = createRunLogger(root);
  completed.finish("completed");
  const completedPath = path.join(root, ".aethel", "logs", `${completed.runId}.jsonl`);
  fs.utimesSync(completedPath, old, old);
  const current = createRunLogger(root);
  assert.ok(!fs.existsSync(abandoned.path));
  assert.ok(!fs.existsSync(completedPath));
  current.finish("completed");
});

test("quoted secrets in error messages are redacted", () => {
  const value = sanitizeLogValue(new Error('{"access_token":"private-value"}'));
  assert.ok(!JSON.stringify(value).includes("private-value"));
});

test("CLI commands, help, and parse errors finalize their logs", t => {
  const root = createTestWorkspace(t, { prefix: "aethel-log-" });
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const cases = [
    { args: ["log"], exitCode: 0 },
    { args: ["--help"], exitCode: 0 },
    { args: ["--unknown-option"], exitCode: 1 },
  ];
  for (const { args, exitCode } of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, exitCode, result.stderr);
  }
  const files = readLogFiles(root);
  assert.equal(files.length, 3);
  assert.ok(files.every(file => !file.name.includes("active")));
  const runs = files.map(file => parseRecords(file.text));
  assert.ok(runs.some(events => events.some(event => event.event === "command.started" && event.details.command === "log")));
  assert.equal(runs.filter(events => events.at(-1).details.status === "failed").length, 1);
});
