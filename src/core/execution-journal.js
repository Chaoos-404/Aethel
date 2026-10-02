import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite } from "./config.js";

export const operationKey = entry => JSON.stringify(Object.fromEntries(
  Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))
));

/** Append and fsync receipts before acknowledging an operation to the caller. */
export function openExecutionJournal(root) {
  const filename = path.join(root, ".aethel", "execution.jsonl");
  const operations = new Map();
  let text = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : "";
  const lines = text.split("\n");
  // An interrupted append cannot acknowledge success. Preserve preceding
  // started records and discard only an incomplete trailing line.
  if (lines.at(-1)) {
    lines.pop();
    atomicWrite(filename, lines.join("\n") + (lines.length ? "\n" : ""));
  } else lines.pop();
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.version !== 1 || !record.id || !["started", "completed", "failed", "acknowledged"].includes(record.state)) {
      throw new Error("Invalid execution journal; preserve it for recovery.");
    }
    if (record.state === "acknowledged") operations.delete(record.id);
    else operations.set(record.id, record);
  }
  function append(record) {
    let fd;
    try {
      fd = fs.openSync(filename, "a", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, ...record }) + "\n");
      fs.fsyncSync(fd);
    } catch (cause) {
      throw Object.assign(new Error("Execution journal could not be persisted; synchronization stopped."), { code: "JOURNAL_IO", cause });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (record.state === "acknowledged") operations.delete(record.id);
    else operations.set(record.id, { version: 1, ...record });
  }
  return {
    newId: () => crypto.randomUUID(),
    record(id, state, original, entry) { append({ id, state, original, entry }); },
    completed: () => [...operations.values()].filter(op => op.state === "completed"),
    assertRecoverable() {
      const uncertain = [...operations.values()].filter(op => op.state === "started");
      if (uncertain.length) throw Object.assign(new Error(
        `Interrupted operations have uncertain outcomes (${uncertain.map(op => `${op.entry.action} ${op.entry.path}`).join(", ")}). Preserve .aethel/execution.jsonl and reconcile these operations before retrying.`
      ), { code: "RECOVERY_REQUIRED" });
    },
    acknowledge(ids) {
      for (const id of ids) append({ id, state: "acknowledged" });
      // Failed operations remain staged; only unacknowledged effects need receipts.
      atomicWrite(filename, [...operations.values()].filter(op => op.state !== "failed")
        .map(op => JSON.stringify(op) + "\n").join(""));
    },
  };
}
