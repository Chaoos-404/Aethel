/**
 * .aethel/ directory management, configuration, and state persistence.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { createManifest } from "./pack-manifest.js";
import { assertWorkspaceWritable } from "./workspace-lock.js";

export const AETHEL_DIR = ".aethel";
export const CONFIG_FILE = "config.json";
export const INDEX_FILE = "index.json";
export const SNAPSHOTS_DIR = "snapshots";
export const HISTORY_DIR = "history";
export const LATEST_SNAPSHOT = "latest.json";
export const PACK_MANIFEST_FILE = "pack-manifest.json";
export const PACK_CONFIG_FILE = ".aethelconfig";

/** Durable replacement prevents interrupted writes from truncating state. */
export function atomicWrite(filename, text) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** Walk up from `start` looking for a .aethel/ directory. */
export function findRoot(start = process.cwd()) {
  let p = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(p, AETHEL_DIR))) return p;
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

/** Return the workspace root or throw. */
export function requireRoot(start) {
  const root = findRoot(start);
  if (!root) {
    throw new Error(
      "Not an Aethel workspace (no .aethel/ found). Run 'aethel init' first."
    );
  }
  return root;
}

function dot(root) {
  return path.join(root, AETHEL_DIR);
}

/** Create a fresh .aethel/ workspace. Returns the root path. */
export function initWorkspace(localPath, driveFolderId = null, driveFolderName = "My Drive") {
  const root = path.resolve(localPath);
  const d = dot(root);

  if (fs.existsSync(d)) {
    throw new Error(`Workspace already initialised at ${d}`);
  }

  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(d, SNAPSHOTS_DIR));
  fs.mkdirSync(path.join(d, SNAPSHOTS_DIR, HISTORY_DIR));

  const config = {
    version: 1,
    drive_folder_id: driveFolderId,
    drive_folder_name: driveFolderName,
    local_path: root,
  };

  writeConfig(root, config);
  writeIndex(root, { staged: [] });
  return root;
}

// ── config helpers ───────────────────────────────────────────────────

export function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(dot(root), CONFIG_FILE), "utf-8"));
}

export function writeConfig(root, data) {
  atomicWrite(
    path.join(dot(root), CONFIG_FILE),
    JSON.stringify(data, null, 2) + "\n"
  );
}

// ── index (staging area) helpers ─────────────────────────────────────

export function readIndex(root) {
  const p = path.join(dot(root), INDEX_FILE);
  if (!fs.existsSync(p)) return { staged: [] };
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function writeIndex(root, data) {
  assertWorkspaceWritable(root);
  atomicWrite(
    path.join(dot(root), INDEX_FILE),
    JSON.stringify(data, null, 2) + "\n"
  );
}

// ── snapshot helpers ─────────────────────────────────────────────────

export function latestSnapshotPath(root) {
  return path.join(dot(root), SNAPSHOTS_DIR, LATEST_SNAPSHOT);
}

export function readLatestSnapshot(root, { verify = false } = {}) {
  const p = latestSnapshotPath(root);
  if (!fs.existsSync(p)) return null;
  const snapshot = JSON.parse(fs.readFileSync(p, "utf-8"));

  if (verify && snapshot._checksum) {
    const canonical = JSON.stringify({
      timestamp: snapshot.timestamp,
      message: snapshot.message,
      files: snapshot.files,
      localFiles: snapshot.localFiles,
    });
    const actual = crypto.createHash("sha256").update(canonical).digest("hex");
    if (actual !== snapshot._checksum) {
      throw new Error(
        `Snapshot integrity check failed: checksum mismatch. ` +
        `The snapshot file may have been tampered with.`
      );
    }
  }

  return snapshot;
}

export function writeSnapshot(root, snapshot) {
  const snapDir = path.join(dot(root), SNAPSHOTS_DIR);
  const latest = path.join(snapDir, LATEST_SNAPSHOT);

  // Archive previous latest
  if (fs.existsSync(latest)) {
    const ts = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d+Z/, "Z");
    fs.copyFileSync(latest, path.join(snapDir, HISTORY_DIR, `${ts}.json`));
  }

  // Compact JSON — snapshots can be large, pretty-printing is slow + wastes disk
  atomicWrite(latest, JSON.stringify(snapshot) + "\n");
}

// ── pack config helpers ───────────────────────────────────────────────

const DEFAULT_PACK_CONFIG = {
  packing: {
    enabled: false,
    compression: {
      default: {
        algorithm: "zstd",
        level: 6,
      },
      overrides: [],
    },
    rules: [],
  },
};

/**
 * Load pack configuration from .aethelconfig (YAML).
 * Returns default config if file doesn't exist.
 * @param {string} root - Workspace root
 * @returns {object} Pack configuration
 */
export function loadPackConfig(root) {
  const p = path.join(root, PACK_CONFIG_FILE);
  if (!fs.existsSync(p)) {
    return structuredClone(DEFAULT_PACK_CONFIG);
  }
  try {
    const content = fs.readFileSync(p, "utf-8");
    const parsed = YAML.parse(content);
    // Merge with defaults for missing keys
    return {
      packing: {
        ...DEFAULT_PACK_CONFIG.packing,
        ...parsed?.packing,
        compression: {
          ...DEFAULT_PACK_CONFIG.packing.compression,
          ...parsed?.packing?.compression,
        },
      },
    };
  } catch {
    return structuredClone(DEFAULT_PACK_CONFIG);
  }
}

/**
 * Save pack configuration to .aethelconfig.
 * @param {string} root - Workspace root
 * @param {object} config - Configuration to save
 */
export function savePackConfig(root, config) {
  const p = path.join(root, PACK_CONFIG_FILE);
  const content = YAML.stringify(config);
  fs.writeFileSync(p, content);
}

/**
 * Read pack manifest from .aethel/pack-manifest.json.
 * Returns empty manifest if file doesn't exist.
 * @param {string} root - Workspace root
 * @returns {object} Pack manifest
 */
export function loadPackManifest(root) {
  const p = path.join(dot(root), PACK_MANIFEST_FILE);
  if (!fs.existsSync(p)) {
    return createManifest();
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return createManifest();
  }
}

/**
 * Save pack manifest to .aethel/pack-manifest.json.
 * @param {string} root - Workspace root
 * @param {object} manifest - Manifest to save
 */
export function savePackManifest(root, manifest) {
  const p = path.join(dot(root), PACK_MANIFEST_FILE);
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Check if packing feature is enabled.
 * @param {string} root - Workspace root
 * @returns {boolean}
 */
export function isPackingEnabled(root) {
  const config = loadPackConfig(root);
  return config.packing?.enabled === true;
}

/**
 * Get packing rule for a specific path.
 * @param {object} packConfig - Pack configuration
 * @param {string} relativePath - Path to check
 * @returns {object|null} Matching rule or null
 */
export function getPackRule(packConfig, relativePath) {
  const rules = packConfig.packing?.rules ?? [];
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

  for (const rule of rules) {
    const rulePath = rule.path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (normalized === rulePath || normalized.startsWith(rulePath + "/")) {
      return rule;
    }
  }

  return null;
}
