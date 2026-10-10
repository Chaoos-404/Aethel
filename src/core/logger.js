import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
const MAX_RECORD_BYTES = 16 * 1024;
// Events that carry a run's outcome. Once the size limit is reached the
// per-operation records are dropped, but these still use the reserved space so
// the totals of a large run can be read from the log.
const OUTCOME_EVENTS = new Set([
  "sync.started",
  "sync.finished",
  "execution.checkpointed",
  "baseline.saved",
  "run.error",
]);
const SECRET_KEY = /token|secret|password|authorization|cookie|credential|private.?key/i;

function redactText(value) {
  return value
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:access_token|refresh_token|id_token|client_secret|password|authorization|api_key)["']?\s*[=:]\s*["']?)[^"'\s&,;}]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s]+/gi, "[URL REDACTED]")
    .slice(0, 2048);
}

/** Never serialize request/response bodies, headers, or arbitrary Error fields. */
export function sanitizeLogValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= 6 || seen.has(value)) return "[TRUNCATED]";
  seen.add(value);
  if (value instanceof Error) {
    return sanitizeLogValue({ name: value.name, message: value.message,
      code: value.code, status: value.response?.status }, depth + 1, seen);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeLogValue(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) =>
    [key, SECRET_KEY.test(key) || /^(headers|request|response|config|body|data)$/i.test(key)
      ? "[REDACTED]" : sanitizeLogValue(item, depth + 1, seen)]));
}

/** Each process/run owns a separate file; retention never rotates an active run. */
export function createRunLogger(root, {
  command = "sync", maxBytes = 5 * 1024 * 1024, maxFiles = 20,
  retentionMs = 7 * 24 * 60 * 60 * 1000, now = Date.now,
  warn = message => process.stderr.write(`${message}\n`),
} = {}) {
  const runId = crypto.randomUUID();
  const directory = path.join(root, ".aethel", "logs");
  const activePath = path.join(directory, `${runId}.active.jsonl`);
  const finishedPath = path.join(directory, `${runId}.jsonl`);
  let fd, bytes = 0, sequence = 0, warned = false, finished = false, limited = false, dropped = 0;
  const started = now();
  function warning() {
    if (warned) return;
    warned = true;
    try { warn("Aethel diagnostic logging is unavailable; sync execution continues."); } catch {}
  }
  function prune() {
    const entries = fs.readdirSync(directory)
      .filter(name => /^[a-f0-9-]+(?:\.active)?\.jsonl$/.test(name))
      .map(name => ({ name, modified: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    let retained = 0;
    for (const entry of entries) {
      if (entry.name.endsWith(".active.jsonl")) {
        if (now() - entry.modified > retentionMs) fs.rmSync(path.join(directory, entry.name), { force: true });
      } else if (++retained > maxFiles || now() - entry.modified > retentionMs) {
        fs.rmSync(path.join(directory, entry.name), { force: true });
      }
    }
  }
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fd = fs.openSync(activePath, "wx", 0o600);
    prune();
  } catch { warning(); }

  function write(level, event, details = {}, terminal = false) {
    if (finished || fd === undefined) return;
    try {
      let record = { version: 1, timestamp: new Date(now()).toISOString(), runId,
        pid: process.pid, sequence: ++sequence, level, event: redactText(event),
        details: sanitizeLogValue(details) };
      let line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        record.details = { truncated: true };
        line = JSON.stringify(record) + "\n";
      }
      const limit = Math.max(maxBytes, MAX_RECORD_BYTES * 2);
      const reserved = terminal || OUTCOME_EVENTS.has(event);
      if (!reserved && bytes + Buffer.byteLength(line) > limit - MAX_RECORD_BYTES) {
        dropped++;
        if (!limited) {
          limited = true;
          write("warn", "log.limit_reached", { maxBytes: limit }, true);
        }
        return;
      }
      if (bytes + Buffer.byteLength(line) > limit) return;
      fs.writeFileSync(fd, line);
      bytes += Buffer.byteLength(line);
    } catch {
      // A partial disk write must not be followed by another JSON record.
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
      warning();
    }
  }
  write("info", "run.started", { command });
  return {
    runId, path: activePath, log: write,
    finish(status, details = {}) {
      if (finished) return;
      write(status === "failed" ? "error" : status === "incomplete" ? "warn" : "info", "run.finished",
        { ...details, status, durationMs: now() - started, ...(dropped ? { droppedRecords: dropped } : {}) }, true);
      finished = true;
      try {
        if (fd !== undefined) { fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; }
        fs.renameSync(activePath, finishedPath);
        prune();
      } catch {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
        warning();
      }
    },
  };
}

export function logEvent(level, event, details) {
  context.getStore()?.log(level, event, details);
}

export async function withRunLog(root, command, work) {
  if (!root || context.getStore()) return work();
  const logger = createRunLogger(root, { command });
  return context.run(logger, async () => {
    try {
      const result = await work();
      const failed = result?.errors?.length || process.exitCode;
      logger.finish(failed ? "incomplete" : "completed", { exitCode: process.exitCode || 0 });
      return result;
    } catch (error) {
      logEvent("error", "run.error", { error });
      logger.finish("failed");
      throw error;
    }
  });
}
