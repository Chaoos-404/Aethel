import test from "node:test";
import assert from "node:assert/strict";
import { remoteCacheEnabledByDefault } from "../src/core/sync-cache-policy.js";

test("classification and mutation commands refresh changes from other devices", () => {
  for (const command of ["status", "add", "push", "fetch", "pull"]) {
    assert.equal(remoteCacheEnabledByDefault(command), false, command);
  }
});
