import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../src/core/config.js";

/** Register cleanup immediately, including when later fixture setup fails. */
export function createTempDirectory(t, prefix = "aethel-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function createTestWorkspace(t, { prefix, driveFolderId = null } = {}) {
  const root = createTempDirectory(t, prefix);
  initWorkspace(root, driveFolderId);
  return root;
}
