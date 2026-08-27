import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAuthClient, resetAuth } from "../src/core/auth.js";
import { getDriveAgent, resetDriveAgent } from "../src/core/http-agent.js";

test("getAuthClient preserves missing-credentials errors", async () => {
  resetAuth();
  const missingCredentialsPath = path.join(
    os.tmpdir(),
    `aethel-missing-credentials-${process.pid}-${Date.now()}.json`
  );
  const tokenPath = path.join(
    os.tmpdir(),
    `aethel-token-${process.pid}-${Date.now()}.json`
  );

  await assert.rejects(
    getAuthClient(missingCredentialsPath, tokenPath),
    /OAuth credentials file not found/
  );

  await assert.rejects(
    getAuthClient(missingCredentialsPath, tokenPath),
    /OAuth credentials file not found/
  );
});

test("auth command forces fresh OAuth instead of reusing cached token", () => {
  const cliSource = fs.readFileSync(
    path.resolve("src", "cli.js"),
    "utf8"
  );
  const repositorySource = fs.readFileSync(
    path.resolve("src", "core", "repository.js"),
    "utf8"
  );

  assert.match(cliSource, /handleAuth\(options\)[\s\S]*forceAuth: true/);
  assert.match(repositorySource, /authenticate\([\s\S]*force: Boolean\(this\._options\.forceAuth\)/);
});

test("getDriveAgent keeps a bounded pool of connections warm", () => {
  resetDriveAgent();
  const agent = getDriveAgent();

  try {
    assert.equal(agent.keepAlive, true);
    // The default 5s idle window on https.globalAgent throws the pool away
    // between phases of a sync.
    assert.ok(agent.options.timeout > 30_000);
    assert.ok(Number.isFinite(agent.maxSockets));
    assert.equal(agent.maxSockets, agent.maxFreeSockets);
    assert.equal(getDriveAgent(), agent, "agent should be reused across calls");
  } finally {
    resetDriveAgent();
  }
});

test("getDriveAgent sizes the pool from the concurrency settings", () => {
  const previous = process.env.AETHEL_DRIVE_CONCURRENCY;
  process.env.AETHEL_DRIVE_CONCURRENCY = "64";
  resetDriveAgent();

  try {
    assert.ok(getDriveAgent().maxSockets >= 64);
  } finally {
    if (previous === undefined) {
      delete process.env.AETHEL_DRIVE_CONCURRENCY;
    } else {
      process.env.AETHEL_DRIVE_CONCURRENCY = previous;
    }
    resetDriveAgent();
  }
});

test("getDriveAgent defers to gaxios when a proxy is configured", () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://proxy.example:8080";
  resetDriveAgent();

  try {
    assert.equal(getDriveAgent(), null);
  } finally {
    if (previous === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = previous;
    }
    resetDriveAgent();
  }
});

test("authenticate hands the shared agent to the Drive client", () => {
  const authSource = fs.readFileSync(
    path.resolve("src", "core", "auth.js"),
    "utf8"
  );

  assert.match(authSource, /const agent = getDriveAgent\(\);/);
  assert.match(authSource, /drive\(\{ version: "v3", auth: authClient, \.\.\.\(agent \? \{ agent \} : \{\}\) \}\)/);
});
