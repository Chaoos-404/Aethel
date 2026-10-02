import fs from "node:fs";
import path from "node:path";
import {
  AETHEL_DIR,
  getPackRule,
  loadPackConfig,
  loadPackManifest,
  readConfig,
  savePackConfig,
  savePackManifest,
} from "./config.js";
import { downloadFile, ensureFolder, uploadFile } from "./drive-api.js";
import { createPack, extractPack, getTreeHash } from "./pack.js";
import {
  generatePackId,
  getPack,
  listPacks,
  removePack,
  setPack,
} from "./pack-manifest.js";

export const PACK_REMOTE_ROOT = ".aethel/packs";

function normalizePackPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function assertPackPath(root, packPath) {
  const normalized = normalizePackPath(packPath);
  if (!normalized) {
    throw new Error("Pack path is required.");
  }

  const abs = path.resolve(root, ...normalized.split("/"));
  const resolvedRoot = path.resolve(root);
  if (!abs.startsWith(resolvedRoot + path.sep) && abs !== resolvedRoot) {
    throw new Error(`Path traversal blocked: ${packPath}`);
  }
  return { normalized, abs };
}

function packTempDir(root) {
  return path.join(root, AETHEL_DIR, "tmp", "packs");
}

function extensionForPack(packResult, basePath) {
  return packResult.packPath.slice(basePath.length);
}

function compressionForPath(config, packPath) {
  const compression = config.packing?.compression || {};
  const defaults = compression.default || {};
  const overrides = compression.overrides || [];
  const override = overrides.find((entry) => {
    const overridePath = normalizePackPath(entry.path);
    return packPath === overridePath || packPath.startsWith(`${overridePath}/`);
  });

  return {
    algorithm: override?.algorithm || defaults.algorithm || "gzip",
    level: override?.level ?? defaults.level ?? 6,
  };
}

function ensurePackingEnabledConfig(config) {
  return {
    ...config,
    packing: {
      enabled: true,
      compression: {
        default: { algorithm: "gzip", level: 6 },
        ...(config.packing?.compression || {}),
      },
      rules: config.packing?.rules || [],
    },
  };
}

function ruleExists(config, packPath) {
  return Boolean(getPackRule(config, packPath));
}

function isMissingRemoteError(err) {
  // Pack manifests explicitly support recreating a missing archive. Ordinary
  // tracked-file uploads stop instead; unwrap their error only at this caller.
  const source = err?.code === "REMOTE_CHANGED" ? err.cause : err;
  const status = source?.response?.status ?? source?.code;
  return status === 404 || status === "404";
}

async function uploadPackArchive(drive, localArchivePath, archivePath, parentId, existingRemoteFileId) {
  try {
    return await uploadFile(drive, localArchivePath, archivePath, {
      parentId,
      existingId: existingRemoteFileId || null,
    });
  } catch (err) {
    if (!existingRemoteFileId || !isMissingRemoteError(err)) {
      throw err;
    }
    return uploadFile(drive, localArchivePath, archivePath, { parentId });
  }
}

export function addPackRules(root, paths, { algorithm, level } = {}) {
  let config = ensurePackingEnabledConfig(loadPackConfig(root));
  const rules = [...(config.packing.rules || [])];
  const existing = new Set(rules.map((rule) => normalizePackPath(rule.path)));

  for (const rawPath of paths) {
    const packPath = normalizePackPath(rawPath);
    if (!packPath || existing.has(packPath)) {
      continue;
    }
    rules.push({ path: packPath, strategy: "full" });
    existing.add(packPath);
  }

  config = {
    ...config,
    packing: {
      ...config.packing,
      rules,
      compression: {
        ...config.packing.compression,
        default: {
          ...config.packing.compression.default,
          ...(algorithm ? { algorithm } : {}),
          ...(level !== undefined ? { level: Number(level) } : {}),
        },
      },
    },
  };

  savePackConfig(root, config);
  return config;
}

export function removePackRules(root, paths) {
  const config = loadPackConfig(root);
  const removeSet = new Set(paths.map(normalizePackPath));
  const nextRules = (config.packing?.rules || []).filter(
    (rule) => !removeSet.has(normalizePackPath(rule.path))
  );

  const nextConfig = {
    ...config,
    packing: {
      ...config.packing,
      rules: nextRules,
    },
  };

  const manifest = loadPackManifest(root);
  for (const packPath of removeSet) {
    removePack(manifest, packPath);
  }

  savePackConfig(root, nextConfig);
  savePackManifest(root, manifest);
  return { config: nextConfig, manifest };
}

export function getPackList(root) {
  const config = loadPackConfig(root);
  const manifest = loadPackManifest(root);
  const rulePaths = new Set(
    (config.packing?.rules || []).map((rule) => normalizePackPath(rule.path))
  );
  const rows = [];

  for (const rulePath of rulePaths) {
    rows.push({
      path: rulePath,
      configured: true,
      info: getPack(manifest, rulePath),
    });
  }

  for (const { path: manifestPath, info } of listPacks(manifest)) {
    if (!rulePaths.has(manifestPath)) {
      rows.push({ path: manifestPath, configured: false, info });
    }
  }

  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

export async function pushPack(drive, root, packPath) {
  const { normalized, abs } = assertPackPath(root, packPath);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Pack source is not a directory: ${normalized}`);
  }

  const config = loadPackConfig(root);
  if (!config.packing?.enabled || !ruleExists(config, normalized)) {
    throw new Error(`No enabled pack rule matches: ${normalized}`);
  }

  const workspaceConfig = readConfig(root);
  const manifest = loadPackManifest(root);
  const existing = getPack(manifest, normalized) || {};
  const packId = existing.packId || generatePackId(normalized);
  const tempDir = packTempDir(root);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const basePath = path.join(tempDir, packId);
  const compression = compressionForPath(config, normalized);
  const packResult = await createPack(abs, basePath, compression);
  const extension = extensionForPack(packResult, basePath);
  const archivePath = `${PACK_REMOTE_ROOT}/${packId}${extension}`;
  const parentId = await ensureFolder(
    drive,
    path.posix.dirname(archivePath),
    workspaceConfig.drive_folder_id || null
  );

  try {
    const remote = await uploadPackArchive(
      drive,
      packResult.packPath,
      archivePath,
      parentId,
      existing.remoteFileId || null
    );

    setPack(manifest, normalized, {
      packId,
      archivePath,
      archiveName: path.posix.basename(archivePath),
      remoteFileId: remote.id,
      remoteMd5Checksum: remote.md5Checksum || null,
      remoteModifiedTime: remote.modifiedTime || null,
      localTreeHash: packResult.treeHash,
      remoteTreeHash: packResult.treeHash,
      fileCount: packResult.fileCount,
      originalSize: packResult.originalSize,
      packedSize: Number(remote.size || packResult.packedSize),
      compression: packResult.compression,
      syncedAt: new Date().toISOString(),
    });
    savePackManifest(root, manifest);

    return {
      path: normalized,
      packId,
      archivePath,
      remoteFileId: remote.id,
      ...packResult,
    };
  } finally {
    await fs.promises.rm(packResult.packPath, { force: true }).catch(() => {});
  }
}

export async function pullPack(drive, root, packPath) {
  const { normalized, abs } = assertPackPath(root, packPath);
  const manifest = loadPackManifest(root);
  const entry = getPack(manifest, normalized);

  if (!entry?.remoteFileId) {
    throw new Error(`Pack has no remote archive to pull: ${normalized}`);
  }

  const remoteMeta = await drive.files.get({
    fileId: entry.remoteFileId,
    fields: "id,name,mimeType,md5Checksum,modifiedTime,size",
    supportsAllDrives: true,
  });
  const remote = remoteMeta.data;
  const archiveName = remote.name || entry.archiveName || path.posix.basename(entry.archivePath || entry.packId);
  const tempDir = packTempDir(root);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const pullTempDir = await fs.promises.mkdtemp(path.join(tempDir, `${entry.packId}-pull-`));
  const tempArchive = path.join(pullTempDir, archiveName);
  const extractDir = path.join(pullTempDir, "extract");

  try {
    await downloadFile(drive, { ...remote, id: entry.remoteFileId }, tempArchive);

    await fs.promises.mkdir(extractDir, { recursive: true });
    const extractResult = await extractPack(tempArchive, extractDir, {
      algorithm: entry.compression?.algorithm,
    });
    const treeHash = await getTreeHash(extractDir);

    await fs.promises.rm(abs, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.rename(extractDir, abs);

    setPack(manifest, normalized, {
      ...entry,
      archiveName,
      remoteMd5Checksum: remote.md5Checksum || entry.remoteMd5Checksum || null,
      remoteModifiedTime: remote.modifiedTime || entry.remoteModifiedTime || null,
      localTreeHash: treeHash,
      remoteTreeHash: treeHash,
      fileCount: extractResult.fileCount,
      originalSize: extractResult.extractedSize,
      packedSize: Number(remote.size || entry.packedSize || 0),
      syncedAt: new Date().toISOString(),
    });
    savePackManifest(root, manifest);

    return {
      path: normalized,
      packId: entry.packId,
      archivePath: entry.archivePath,
      remoteFileId: entry.remoteFileId,
      treeHash,
      ...extractResult,
    };
  } finally {
    await fs.promises.rm(pullTempDir, { recursive: true, force: true }).catch(() => {});
  }
}
