import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AETHEL_DIR, loadPackConfig, getPackRule } from "./config.js";
import { loadIgnoreRules } from "./ignore.js";
import { getTreeHash } from "./pack.js";

const HASH_CACHE_FILE = ".hash-cache.json";

function isMissingLocalFileError(err) {
  return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

export async function md5Local(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Stream-hash a file with the given algorithm (default sha256).
 * Returns hex digest.
 */
export async function hashFile(filePath, algorithm = "sha256") {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Compute a SHA-256 integrity checksum over the snapshot's data fields.
 * The checksum covers files + localFiles + message + timestamp, but NOT
 * the checksum field itself, so it can be verified after reading.
 */
export function computeSnapshotChecksum(snapshot) {
  const canonical = JSON.stringify({
    timestamp: snapshot.timestamp,
    message: snapshot.message,
    files: snapshot.files,
    localFiles: snapshot.localFiles,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Verify a snapshot's embedded checksum.  Returns true if valid or
 * if the snapshot has no checksum (pre-integrity snapshots).
 */
export function verifySnapshotChecksum(snapshot) {
  if (!snapshot?._checksum) return { valid: true, reason: "no checksum (legacy snapshot)" };
  const expected = snapshot._checksum;
  const actual = computeSnapshotChecksum(snapshot);
  if (actual === expected) return { valid: true, reason: "checksum valid" };
  return { valid: false, reason: `checksum mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…` };
}

// ── Hash cache ───────────────────────────────────────────────────────

function hashCachePath(root) {
  return path.join(root, AETHEL_DIR, HASH_CACHE_FILE);
}

function loadHashCache(root) {
  const p = hashCachePath(root);
  if (!fs.existsSync(p)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveHashCache(root, cache) {
  const p = hashCachePath(root);
  const obj = Object.fromEntries(cache);
  fs.writeFileSync(p, JSON.stringify(obj) + "\n");
}

// ── Scanning ─────────────────────────────────────────────────────────

const PARALLEL_HASH_LIMIT = 128;

/** Rebuild an object with its keys in sorted order (walk order is not stable). */
function sortObjectKeys(source) {
  const sorted = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = source[key];
  }
  return sorted;
}

export async function scanLocal(root, { respectIgnore = true, respectPacking = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const ignoreRules = respectIgnore ? loadIgnoreRules(resolvedRoot) : null;
  const packConfig = respectPacking ? loadPackConfig(resolvedRoot) : null;
  const packingEnabled = packConfig?.packing?.enabled === true;
  const hashCache = loadHashCache(resolvedRoot);
  const nextCache = new Map();
  // Read-only commands (status, diff, fetch) scan without changing anything;
  // don't rewrite the cache file when no entry actually moved.
  let hashCacheDirty = false;

  // Phase 1: collect all file stats (fast — no hashing yet)
  const filesToHash = [];
  const packedDirs = {};
  // Track directories and their child counts to detect empty folders
  const dirChildCount = new Map();
  // Map relative dir path → absolute path (for deferred stat on empty dirs only)
  const dirAbsPath = new Map();

  async function walk(currentPath) {
    let entries;
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    const relativeDirPath = currentPath === resolvedRoot
      ? null
      : path.relative(resolvedRoot, currentPath).split(path.sep).join("/");

    // Register this directory (skip root itself)
    if (relativeDirPath !== null) {
      if (!dirChildCount.has(relativeDirPath)) {
        dirChildCount.set(relativeDirPath, 0);
        dirAbsPath.set(relativeDirPath, currentPath);
      }
    }

    const subdirs = [];
    const statPromises = [];
    let trackedChildren = 0;

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path
        .relative(resolvedRoot, fullPath)
        .split(path.sep)
        .join("/");

      if (entry.isDirectory()) {
        // Check if this directory is a pack target BEFORE checking ignore rules
        // Pack targets should be processed even if they match ignore patterns
        if (packingEnabled) {
          const packRule = getPackRule(packConfig, relativePath);
          if (packRule && packRule.path === relativePath) {
            // This directory should be packed - compute tree hash instead of scanning
            try {
              const treeHash = await getTreeHash(fullPath);
              packedDirs[relativePath] = {
                path: relativePath,
                isPacked: true,
                treeHash,
                packRule: packRule.strategy || "full",
              };
            } catch {
              // If we can't compute tree hash, fall back to normal scanning
              if (!ignoreRules?.ignores(relativePath)) {
                trackedChildren++;
                subdirs.push(fullPath);
              }
            }
            continue; // Don't descend into packed directory
          }
        }

        // Apply ignore rules for non-pack directories
        if (ignoreRules?.ignores(relativePath)) {
          continue;
        }
        trackedChildren++;
        subdirs.push(fullPath);
        continue;
      }

      // Apply ignore rules for files
      if (ignoreRules?.ignores(relativePath)) {
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      trackedChildren++;
      statPromises.push(
        fs.promises
          .stat(fullPath)
          .then((stat) => {
            filesToHash.push({ fullPath, relativePath, stat });
          })
          .catch((err) => {
            if (!isMissingLocalFileError(err)) {
              throw err;
            }
          })
      );
    }

    if (relativeDirPath !== null) {
      dirChildCount.set(relativeDirPath, trackedChildren);
    }

    await Promise.all([
      ...statPromises,
      ...subdirs.map((dir) => walk(dir)),
    ]);
  }

  await walk(resolvedRoot);

  // The walk collects stats as they resolve, so `filesToHash` arrives in
  // completion order. Sort it: the insertion order of `result` becomes the
  // order changes are reported in, and that should not shuffle between runs.
  filesToHash.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );

  // Phase 2: hash files with a continuously refilled pool, using cache when
  // possible. Fixed batches made every cache hit — which costs nothing — wait
  // for the slowest cold file in its group of 128 before any further file
  // started. Workers pull from a shared cursor instead, so a slot is busy
  // exactly as long as it takes to hash one file.
  const result = {};
  const hashes = new Array(filesToHash.length);
  let nextFileIndex = 0;

  async function hashWorker() {
    for (;;) {
      const currentIndex = nextFileIndex++;
      if (currentIndex >= filesToHash.length) return;
      const { fullPath, relativePath, stat } = filesToHash[currentIndex];
      try {
        const { md5, fromCache } = await getMd5Cached(
          hashCache,
          nextCache,
          fullPath,
          relativePath,
          stat
        );
        if (!fromCache) hashCacheDirty = true;
        hashes[currentIndex] = { relativePath, stat, md5 };
      } catch (err) {
        if (!isMissingLocalFileError(err)) {
          throw err;
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(PARALLEL_HASH_LIMIT, filesToHash.length) },
      hashWorker
    )
  );

  // Results land in `filesToHash` order, so `result` keeps the sorted
  // insertion order that change reporting depends on.
  for (const hashResult of hashes) {
    if (!hashResult) {
      continue;
    }
    const { relativePath, stat, md5 } = hashResult;
    result[relativePath] = {
      localPath: relativePath,
      size: stat.size,
      md5,
      modifiedTime: new Date(stat.mtimeMs).toISOString(),
    };
  }

  // Phase 3: detect empty folders (directories with zero tracked children)
  // Walk bottom-up: a dir is "empty" if it has no tracked children AND
  // all its subdirectories are also empty.
  const emptyDirs = new Set();
  // Sort by depth (deepest first) for bottom-up processing
  const sortedDirs = [...dirChildCount.keys()].sort(
    (a, b) => b.split("/").length - a.split("/").length
  );

  for (const dirPath of sortedDirs) {
    const childCount = dirChildCount.get(dirPath);
    if (childCount === 0) {
      emptyDirs.add(dirPath);
      // Propagate: decrement parent's tracked child count since this child is empty
      const parentDir = dirPath.includes("/")
        ? dirPath.slice(0, dirPath.lastIndexOf("/"))
        : null;
      if (parentDir && dirChildCount.has(parentDir)) {
        dirChildCount.set(parentDir, dirChildCount.get(parentDir) - 1);
      }
    }
  }

  // Only stat the empty directories (not all directories). Stat in parallel,
  // then record in sorted order so the result stays deterministic.
  const sortedEmptyDirs = [...emptyDirs].sort();
  const emptyDirMtimes = await Promise.all(sortedEmptyDirs.map(async (dirPath) => {
    const absPath = dirAbsPath.get(dirPath);
    if (absPath) {
      try {
        const stat = await fs.promises.stat(absPath);
        return new Date(stat.mtimeMs).toISOString();
      } catch { /* ignore */ }
    }
    return new Date().toISOString();
  }));

  sortedEmptyDirs.forEach((dirPath, index) => {
    result[dirPath] = {
      localPath: dirPath,
      isFolder: true,
      size: 0,
      md5: null,
      modifiedTime: emptyDirMtimes[index],
    };
  });

  // Persist updated cache. A pure cache hit for every scanned file still
  // leaves entries behind if files were deleted, so compare sizes too.
  if (hashCacheDirty || nextCache.size !== hashCache.size) {
    saveHashCache(resolvedRoot, nextCache);
  }

  // Return both files and packed directories
  return {
    files: result,
    packedDirs: sortObjectKeys(packedDirs),
    // For backward compatibility, also expose files at top level
    ...result,
  };
}

async function getMd5Cached(oldCache, newCache, fullPath, relativePath, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = oldCache.get(relativePath);

  let md5;
  let fromCache = false;
  if (cached && cached.startsWith(key + ":")) {
    // Cache hit: mtime and size match
    md5 = cached.slice(key.length + 1);
    fromCache = true;
  } else {
    // Cache miss: compute hash
    md5 = await md5Local(fullPath);
  }

  newCache.set(relativePath, `${key}:${md5}`);
  return { md5, fromCache };
}

// ── Snapshot building ────────────────────────────────────────────────

export function buildSnapshot(remoteFiles, localFiles, message = "", packedDirs = {}) {
  const files = {};

  for (const file of remoteFiles) {
    files[file.id] = {
      id: file.id,
      name: file.name,
      path: file.path,
      md5Checksum: file.md5Checksum ?? null,
      size: file.size ?? null,
      mimeType: file.mimeType || "",
      modifiedTime: file.modifiedTime ?? null,
      localPath: file.path,
      ...(file.isFolder ? { isFolder: true } : {}),
    };
  }

  // Handle localFiles which may be the new format with .files property
  const localFilesData = localFiles?.files ?? localFiles;
  const localPackedDirs = localFiles?.packedDirs ?? packedDirs;

  const snapshot = {
    timestamp: new Date().toISOString(),
    message,
    files,
    localFiles: { ...localFilesData },
    packedDirs: { ...localPackedDirs },
  };

  // Embed integrity checksum
  snapshot._checksum = computeSnapshotChecksum(snapshot);
  return snapshot;
}
