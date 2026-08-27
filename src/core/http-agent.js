/**
 * Shared HTTPS agent for every Drive API call.
 *
 * Without this, gaxios hands requests to node-fetch with no agent, so they
 * land on `https.globalAgent`: idle sockets are reaped after 5s and
 * `maxSockets` is unbounded. A 40-wide burst therefore opens 40 cold TLS
 * handshakes, and any pause longer than 5s (local hashing, TUI think-time,
 * the gap between fetch and transfer) throws the warm pool away.
 *
 * A bounded pool with a 60s idle window keeps connections warm across those
 * pauses and makes bursts queue onto established sockets instead of
 * renegotiating TLS. Node's agent only destroys sockets sitting in the free
 * list when `timeout` fires, so in-flight transfers are never cut short.
 */

import https from "node:https";

const DEFAULT_DRIVE_CONCURRENCY = 40;
const DEFAULT_TRANSFER_CONCURRENCY = 32;
// Spare sockets for calls made outside the pools (token refresh, one-off gets).
const SOCKET_HEADROOM = 8;
const IDLE_SOCKET_TIMEOUT_MS = 60_000;

let cachedAgent = null;
let cachedKey = null;

function readPositiveIntEnv(name, fallback) {
  const rawValue = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : fallback;
}

function hasProxyConfigured() {
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy
  );
}

function poolSize() {
  const driveConcurrency = readPositiveIntEnv(
    "AETHEL_DRIVE_CONCURRENCY",
    DEFAULT_DRIVE_CONCURRENCY
  );
  const transferConcurrency = readPositiveIntEnv(
    "AETHEL_TRANSFER_CONCURRENCY",
    readPositiveIntEnv("AETHEL_DRIVE_CONCURRENCY", DEFAULT_TRANSFER_CONCURRENCY)
  );
  return Math.max(driveConcurrency, transferConcurrency) + SOCKET_HEADROOM;
}

/**
 * Return the shared keep-alive agent, or `null` when a proxy is configured —
 * gaxios builds its own proxy agent, and setting `agent` would disable that.
 */
export function getDriveAgent() {
  if (hasProxyConfigured()) return null;

  const size = poolSize();
  const key = String(size);
  if (cachedAgent && cachedKey === key) return cachedAgent;

  cachedAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    // Reuse the most recently released socket so the warm end of the pool
    // stays warm instead of round-robining every connection to the edge of
    // its idle window.
    scheduling: "lifo",
    maxSockets: size,
    maxFreeSockets: size,
    timeout: IDLE_SOCKET_TIMEOUT_MS,
  });
  cachedKey = key;
  return cachedAgent;
}

/** Drop the shared agent, closing idle sockets. Used by tests and resetAuth. */
export function resetDriveAgent() {
  cachedAgent?.destroy();
  cachedAgent = null;
  cachedKey = null;
}
