import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultIgnoreFile, loadIgnoreRules } from "../src/core/ignore.js";

test("default ignore template covers Python environment and cache directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aethel-default-ignore-"));

  try {
    assert.equal(createDefaultIgnoreFile(root), true);
    const rules = loadIgnoreRules(root);

    for (const directory of [".venv", "__pycache__", "node_modules"]) {
      assert.equal(rules.ignores(`apps/api/${directory}/`), true);
      assert.equal(rules.ignores(`apps/api/${directory}/bin/python`), true);
    }

    // Bare environment names are intentionally not ignored by default —
    // they are too generic and can shadow real project directories.
    for (const directory of ["venv", "env", "ENV", "uv-cache"]) {
      assert.equal(rules.ignores(`apps/api/${directory}/main.py`), false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
