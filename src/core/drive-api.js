import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findRoot } from "./config.js";
import { loadIgnoreRules } from "./ignore.js";

const PAGE_SIZE = 1000;
const CLEANER_BATCH_SIZE = 20;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_ITEM_FIELDS =
  "nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, md5Checksum, parents)";
const CHILD_QUERY_FIELDS =
  "nextPageToken, files(id,name,mimeType,parents,createdTime,modifiedTime,md5Checksum,size,capabilities(canAddChildren,canEdit,canTrash,canDelete,canRename))";
const REMOTE_MEMO_VERSION = 1;
const REMOTE_MEMO_PREFIX = ".aethel-remote-memo-";
const REMOTE_MEMO_FIELDS =
  "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,parents,trashed))";

function readPositiveIntEnv(name, fallback) {
  const rawValue = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : fallback;
}

const DRIVE_API_CONCURRENCY = readPositiveIntEnv(
  "AETHEL_DRIVE_CONCURRENCY",
  40
);
const SCOPED_FETCH_MAX_SNAPSHOT_FILES = readPositiveIntEnv(
  "AETHEL_SCOPED_FETCH_MAX_SNAPSHOT_FILES",
  5000
);
const UPLOAD_BATCH_SIZE = DRIVE_API_CONCURRENCY;
const DEDUPE_BATCH_SIZE = DRIVE_API_CONCURRENCY;

// Retry with exponential backoff for transient Drive API errors (429, 5xx).
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;

function isRetryableError(err) {
  const status = err?.response?.status ?? err?.code;
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function getRetryDelay(err, attempt) {
  // Respect Retry-After header from Google when present (value in seconds).
  const retryAfter = err?.response?.headers?.["retry-after"];
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random());
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt >= RETRY_MAX_ATTEMPTS - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, getRetryDelay(err, attempt)));
    }
  }
}

/**
 * Return a thin wrapper around a googleapis drive client whose
 * `files.*` methods automatically retry on 429 / 5xx.
 * The original object is not mutated.
 */
export function withDriveRetry(drive) {
  const filesProxy = new Proxy(drive.files, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args) => withRetry(() => value.apply(target, args));
    },
  });
  return Object.create(drive, {
    files: { value: filesProxy, configurable: true, enumerable: true },
  });
}

export const EXPORT_MAP = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
  },
  "application/vnd.google-apps.drawing": {
    mime: "application/pdf",
    ext: ".pdf",
  },
};

const MIME_ICONS = {
  [FOLDER_MIME]: "[DIR]",
  "application/vnd.google-apps.document": "[DOC]",
  "application/vnd.google-apps.spreadsheet": "[SHT]",
  "application/vnd.google-apps.presentation": "[SLD]",
  "application/pdf": "[PDF]",
  "image/": "[IMG]",
  "video/": "[VID]",
  "audio/": "[AUD]",
};

export function isWorkspaceType(mime) {
  return mime?.startsWith("application/vnd.google-apps.") ?? false;
}

function escapeDriveQueryValue(value) {
  // Google Drive API query strings use single-quoted values.
  // Escape backslashes first, then single quotes.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}

function remoteMemoEnabled(
  rootFolderId,
  { estimatedRemoteFiles = null, remoteMemoMode = null } = {}
) {
  if (!rootFolderId) {
    return false;
  }
  const mode = String(remoteMemoMode || process.env.AETHEL_REMOTE_MEMO || "auto").toLowerCase();
  if (["0", "false", "off"].includes(mode)) {
    return false;
  }
  if (["1", "true", "on", "force"].includes(mode)) {
    return true;
  }
  return Number.isFinite(estimatedRemoteFiles) &&
    estimatedRemoteFiles > SCOPED_FETCH_MAX_SNAPSHOT_FILES;
}

function remoteMemoName(rootFolderId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(rootFolderId || "root"))
    .digest("hex")
    .slice(0, 24);
  return `${REMOTE_MEMO_PREFIX}${hash}.json`;
}

function isRemoteMemoItem(item) {
  return String(item?.name || "").startsWith(REMOTE_MEMO_PREFIX);
}

function serializeRawRemoteItems({ folders, files }) {
  return {
    folders: [...folders.values()].filter((item) => !isRemoteMemoItem(item)),
    files: files.filter((item) => !isRemoteMemoItem(item)),
  };
}

function deserializeRawRemoteItems(raw) {
  return {
    folders: new Map((raw?.folders || []).map((folder) => [folder.id, folder])),
    files: raw?.files || [],
  };
}

export function iconForMime(mime) {
  for (const [prefix, icon] of Object.entries(MIME_ICONS)) {
    if ((mime || "").startsWith(prefix)) {
      return icon;
    }
  }

  return "[FIL]";
}

export function humanSize(rawSize) {
  if (!rawSize) {
    return "  --  ";
  }

  let size = Number(rawSize);
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (size < 1024) {
      return `${size.toPrecision(4).padStart(5, " ")} ${unit}`;
    }
    size /= 1024;
  }

  return `${size.toFixed(1).padStart(5, " ")} PB`;
}

export function sourceBadgeForItem(item) {
  if (item?.isSharedDriveItem) {
    return "[DRV]";
  }

  if (item?.ownedByMe) {
    return "[MY ]";
  }

  if (item?.shared) {
    return "[SHR]";
  }

  return "[EXT]";
}

function createdTimeRank(item) {
  const value = item?.createdTime ? Date.parse(item.createdTime) : Number.NaN;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function canonicalItemComparator(left, right) {
  const createdDiff = createdTimeRank(left) - createdTimeRank(right);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return String(left.id || "").localeCompare(String(right.id || ""));
}

function pickCanonicalItem(items) {
  if (!items.length) {
    return null;
  }
  return [...items].sort(canonicalItemComparator)[0];
}

/**
 * Build a folder-path resolver from a pre-collected folder map.
 */
function createFolderResolver(folders, rootFolderId) {
  const cache = new Map();

  return function resolve(folderId) {
    if (cache.has(folderId)) return cache.get(folderId);

    if (!folderId) {
      const v = rootFolderId ? null : "";
      cache.set(folderId, v);
      return v;
    }
    if (folderId === rootFolderId) {
      cache.set(folderId, "");
      return "";
    }

    const folder = folders.get(folderId);
    if (!folder) {
      const v = rootFolderId ? null : "";
      cache.set(folderId, v);
      return v;
    }

    const parentPath = resolve(folder.parents?.[0] || "");
    if (rootFolderId && parentPath === null) {
      cache.set(folderId, null);
      return null;
    }

    const result = parentPath
      ? path.posix.join(parentPath, folder.name)
      : folder.name;
    cache.set(folderId, result);
    return result;
  };
}

/**
 * Single-pass fetch: get ALL non-trashed items (folders + files) in one
 * pagination loop, then split in memory. Cuts API round-trips in half.
 */
async function fetchAllItems(drive, { fields, includeSharedDrives = false } = {}) {
  const allFields = fields || DEFAULT_ITEM_FIELDS;
  const folders = new Map();
  const files = [];
  let pageToken = null;

  // Fetch the real My Drive root folder metadata in parallel with
  // the main list.  Google Drive API returns actual folder IDs in
  // `parents` (e.g. "0AJ…"), NOT the alias "root".  Without this,
  // the orphan checker can't recognise the root and marks every
  // top-level folder as orphaned — silently dropping all files.
  const rootPromise = drive.files
    .get({ fileId: "root", fields: "id,name,mimeType,parents,createdTime" })
    .catch(() => null);

  const listOpts = {
    q: "trashed = false",
    fields: allFields,
    pageSize: PAGE_SIZE,
  };
  if (includeSharedDrives) {
    listOpts.includeItemsFromAllDrives = true;
    listOpts.supportsAllDrives = true;
    listOpts.corpora = "allDrives";
  }

  do {
    listOpts.pageToken = pageToken;
    const response = await drive.files.list(listOpts);

    for (const item of response.data.files || []) {
      if (item.mimeType === FOLDER_MIME) {
        folders.set(item.id, item);
      } else {
        files.push(item);
      }
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  // Add the real root folder so the orphan checker can walk up to it.
  const rootRes = await rootPromise;
  if (rootRes?.data?.id) {
    folders.set(rootRes.data.id, rootRes.data);
  }

  return { folders, files };
}

async function listChildItems(drive, parentId, { fields = DEFAULT_ITEM_FIELDS } = {}) {
  const files = [];
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'${escapeDriveQueryValue(parentId)}' in parents and trashed = false`,
      fields,
      pageSize: PAGE_SIZE,
      pageToken,
    });

    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function fetchScopedItems(drive, rootFolderId, { fields = DEFAULT_ITEM_FIELDS } = {}) {
  const folders = new Map();
  const files = [];
  const seenFolderIds = new Set([rootFolderId]);

  const rootResponse = await drive.files.get({
    fileId: rootFolderId,
    fields: "id,name,mimeType,parents,createdTime,modifiedTime",
  });
  if (rootResponse?.data?.id) {
    folders.set(rootResponse.data.id, rootResponse.data);
  }

  let currentLevel = [rootFolderId];
  while (currentLevel.length > 0) {
    const nextLevel = [];
    for (let index = 0; index < currentLevel.length; index += DRIVE_API_CONCURRENCY) {
      const batch = currentLevel.slice(index, index + DRIVE_API_CONCURRENCY);
      const batchChildren = await Promise.all(
        batch.map((parentId) => listChildItems(drive, parentId, { fields }))
      );

      for (const children of batchChildren) {
        for (const item of children) {
          if (item.mimeType === FOLDER_MIME) {
            folders.set(item.id, item);
            if (!seenFolderIds.has(item.id)) {
              seenFolderIds.add(item.id);
              nextLevel.push(item.id);
            }
          } else {
            files.push(item);
          }
        }
      }
    }
    currentLevel = nextLevel;
  }

  return { folders, files };
}

function shouldUseScopedFetch(rootFolderId, { estimatedRemoteFiles = null, fetchMode = null } = {}) {
  if (!rootFolderId) {
    return false;
  }

  const mode = String(fetchMode || process.env.AETHEL_REMOTE_FETCH_MODE || "auto").toLowerCase();
  if (mode === "scoped") {
    return true;
  }
  if (mode === "all" || mode === "global") {
    return false;
  }

  if (!Number.isFinite(estimatedRemoteFiles)) {
    return true;
  }
  return estimatedRemoteFiles <= SCOPED_FETCH_MAX_SNAPSHOT_FILES;
}

async function fetchRemoteItems(drive, rootFolderId = null, options = {}) {
  if (shouldUseScopedFetch(rootFolderId, options)) {
    return fetchScopedItems(drive, rootFolderId, options);
  }
  return fetchAllItems(drive, options);
}

async function findRemoteMemoFile(drive, rootFolderId) {
  const response = await drive.files.list({
    q:
      `'${escapeDriveQueryValue(rootFolderId)}' in parents and ` +
      `name = '${escapeDriveQueryValue(remoteMemoName(rootFolderId))}' and ` +
      "trashed = false",
    fields: "files(id,name,modifiedTime)",
    pageSize: 1,
  });
  return response.data.files?.[0] || null;
}

async function readRemoteMemo(drive, rootFolderId) {
  const memoFile = await findRemoteMemoFile(drive, rootFolderId);
  if (!memoFile?.id) {
    return null;
  }

  const response = await drive.files.get(
    { fileId: memoFile.id, alt: "media" },
    { responseType: "stream" }
  );
  const chunks = [];
  for await (const chunk of response.data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const memo = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  if (
    memo.version !== REMOTE_MEMO_VERSION ||
    (memo.rootFolderId ?? null) !== (rootFolderId ?? null) ||
    !memo.startPageToken ||
    !Array.isArray(memo.folders) ||
    !Array.isArray(memo.files)
  ) {
    return null;
  }

  return { ...memo, fileId: memoFile.id };
}

async function writeRemoteMemo(
  drive,
  rootFolderId,
  rawItems,
  startPageToken,
  existingFileId = null,
  options = {}
) {
  if (!remoteMemoEnabled(rootFolderId, options) || !startPageToken) {
    return;
  }

  const body = JSON.stringify(
    {
      version: REMOTE_MEMO_VERSION,
      rootFolderId: rootFolderId ?? null,
      updatedAt: new Date().toISOString(),
      startPageToken,
      ...serializeRawRemoteItems(rawItems),
    }
  );
  const media = {
    mimeType: "application/json",
    body: Readable.from([body]),
  };

  if (existingFileId) {
    await drive.files.update({
      fileId: existingFileId,
      requestBody: { name: remoteMemoName(rootFolderId) },
      media,
      fields: "id",
    });
    return;
  }

  const existingMemo = await findRemoteMemoFile(drive, rootFolderId);
  if (existingMemo?.id) {
    await drive.files.update({
      fileId: existingMemo.id,
      requestBody: { name: remoteMemoName(rootFolderId) },
      media,
      fields: "id",
    });
    return;
  }

  await drive.files.create({
    requestBody: {
      name: remoteMemoName(rootFolderId),
      parents: [rootFolderId],
    },
    media,
    fields: "id",
  });
}

async function getStartPageToken(drive) {
  const response = await drive.changes.getStartPageToken({
    fields: "startPageToken",
    supportsAllDrives: true,
  });
  return response.data.startPageToken || null;
}

function isChangeTokenExpired(err) {
  return err?.code === 410 || err?.response?.status === 410;
}

function itemParentId(item) {
  return item?.parents?.[0] || "";
}

function itemIsInsideMemoTree(item, trackedFolderIds, rootFolderId) {
  const parentId = itemParentId(item);
  return parentId === rootFolderId || trackedFolderIds.has(parentId);
}

function applyChangedItemsToMemo(memo, changes, rootFolderId) {
  const items = new Map();
  for (const folder of memo.folders || []) {
    if (folder?.id) items.set(folder.id, folder);
  }
  for (const file of memo.files || []) {
    if (file?.id) items.set(file.id, file);
  }

  for (const change of changes) {
    if (change.removed || change.file?.trashed) {
      items.delete(change.fileId);
    }
  }

  const pending = changes
    .filter((change) =>
      !change.removed &&
      !change.file?.trashed &&
      change.file?.id &&
      !isRemoteMemoItem(change.file)
    )
    .map((change) => change.file);

  let changed = true;
  while (changed && pending.length > 0) {
    changed = false;
    const trackedFolderIds = new Set(
      [...items.values()]
        .filter((item) => item.mimeType === FOLDER_MIME)
        .map((item) => item.id)
    );
    trackedFolderIds.add(rootFolderId);

    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index];
      const wasTracked = items.has(item.id);
      const isRoot = item.id === rootFolderId;
      const isInside = isRoot || itemIsInsideMemoTree(item, trackedFolderIds, rootFolderId);

      if (wasTracked || isInside) {
        items.set(item.id, item);
        pending.splice(index, 1);
        changed = true;
      }
    }
  }

  const folders = new Map();
  const files = [];
  for (const item of items.values()) {
    if (isRemoteMemoItem(item)) {
      continue;
    }
    if (item.mimeType === FOLDER_MIME) {
      folders.set(item.id, item);
    } else {
      files.push(item);
    }
  }

  return { folders, files };
}

async function applyRemoteMemoChanges(drive, memo, rootFolderId) {
  const changes = [];
  let pageToken = memo.startPageToken;
  let nextStartPageToken = null;

  do {
    const response = await drive.changes.list({
      pageToken,
      fields: REMOTE_MEMO_FIELDS,
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: PAGE_SIZE,
    });

    changes.push(...(response.data.changes || []));
    pageToken = response.data.nextPageToken || null;
    nextStartPageToken = response.data.newStartPageToken || nextStartPageToken;
  } while (pageToken);

  return {
    rawItems: applyChangedItemsToMemo(memo, changes, rootFolderId),
    startPageToken: nextStartPageToken || memo.startPageToken,
    memoFileId: memo.fileId,
  };
}

async function fetchMemoizedRemoteItems(drive, rootFolderId, options = {}) {
  if (!remoteMemoEnabled(rootFolderId, options)) {
    return null;
  }

  try {
    const memo = await readRemoteMemo(drive, rootFolderId);
    if (!memo) {
      return null;
    }
    return await applyRemoteMemoChanges(drive, memo, rootFolderId);
  } catch (err) {
    if (isChangeTokenExpired(err)) {
      return null;
    }
    if (options.debugRemoteMemo) {
      throw err;
    }
    return null;
  }
}

/**
 * Build a cached orphan checker. A folder is "orphaned" if its parent
 * chain leads to a trashed/inaccessible folder rather than "root".
 *
 * When a folder is trashed, Google Drive does NOT mark its children as
 * trashed. They remain `trashed = false` but their parent is gone from
 * our fetched folder map, making them "orphaned".
 */
function createOrphanChecker(folders, rootFolderId = null) {
  const cache = new Map();

  return function isOrphaned(folderId) {
    if (cache.has(folderId)) return cache.get(folderId);

    // Walk the chain, collecting unresolved IDs
    const pending = [];
    let current = folderId;

    while (current) {
      if (current === "root" || current === rootFolderId) {
        for (const id of pending) cache.set(id, false);
        return false;
      }
      if (cache.has(current)) {
        const result = cache.get(current);
        for (const id of pending) cache.set(id, result);
        return result;
      }
      pending.push(current);
      const folder = folders.get(current);
      if (!folder) {
        for (const id of pending) cache.set(id, true);
        return true;
      }
      current = folder.parents?.[0] || "";
    }

    // No parent — root-level
    for (const id of pending) cache.set(id, false);
    return false;
  };
}

function buildRemoteFiles(folders, rawFiles, rootFolderId = null) {
  const resolve = createFolderResolver(folders, rootFolderId);
  const isOrphaned = createOrphanChecker(folders, rootFolderId);
  const files = [];

  // Track which folders have children (files or subfolders)
  const foldersWithChildren = new Set();

  for (const file of rawFiles) {
    if (isRemoteMemoItem(file)) continue;
    const parentId = file.parents?.[0] || "";

    // Skip files whose parent folder was trashed (orphaned children)
    if (parentId && isOrphaned(parentId)) continue;

    const parentPath = parentId === rootFolderId ? "" : resolve(parentId);

    if (rootFolderId && parentPath === null) continue;

    // Mark parent as having children
    if (parentId) foldersWithChildren.add(parentId);

    files.push({
      id: file.id,
      name: file.name,
      path: parentPath ? path.posix.join(parentPath, file.name) : file.name,
      mimeType: file.mimeType || "",
      size: file.size || null,
      modifiedTime: file.modifiedTime || null,
      md5Checksum: file.md5Checksum || null,
    });
  }

  // Mark folders that have subfolders as children
  for (const folder of folders.values()) {
    if (isRemoteMemoItem(folder)) continue;
    const parentId = folder.parents?.[0] || "";
    if (parentId) foldersWithChildren.add(parentId);
  }

  // Include empty folders (no file children AND no subfolder children)
  for (const folder of folders.values()) {
    if (isRemoteMemoItem(folder)) continue;
    if (foldersWithChildren.has(folder.id)) continue;
    if (isOrphaned(folder.id)) continue;

    const folderPath = resolve(folder.id);
    if (rootFolderId && folderPath === null) continue;
    if (!folderPath) continue; // skip root-level marker

    files.push({
      id: folder.id,
      name: folder.name,
      path: folderPath,
      mimeType: FOLDER_MIME,
      size: null,
      modifiedTime: folder.modifiedTime || null,
      md5Checksum: null,
      isFolder: true,
    });
  }

  return files;
}

function buildRemoteItems(folders, rawFiles, rootFolderId = null) {
  const resolve = createFolderResolver(folders, rootFolderId);
  const isOrphaned = createOrphanChecker(folders, rootFolderId);
  const items = [];

  for (const folder of folders.values()) {
    if (isRemoteMemoItem(folder)) continue;
    if (folder.id === "root" || folder.id === rootFolderId) continue;
    if (isOrphaned(folder.id)) continue;

    const folderPath = resolve(folder.id);
    if (rootFolderId && folderPath === null) continue;
    if (!folderPath) continue;

    items.push({
      id: folder.id,
      name: folder.name,
      path: folderPath,
      mimeType: FOLDER_MIME,
      size: null,
      modifiedTime: folder.modifiedTime || null,
      md5Checksum: null,
      isFolder: true,
    });
  }

  for (const file of rawFiles) {
    if (isRemoteMemoItem(file)) continue;
    const parentId = file.parents?.[0] || "";
    if (parentId && isOrphaned(parentId)) continue;

    const parentPath = parentId === rootFolderId ? "" : resolve(parentId);
    if (rootFolderId && parentPath === null) continue;

    items.push({
      id: file.id,
      name: file.name,
      path: parentPath ? path.posix.join(parentPath, file.name) : file.name,
      mimeType: file.mimeType || "",
      size: file.size || null,
      modifiedTime: file.modifiedTime || null,
      md5Checksum: file.md5Checksum || null,
    });
  }

  return items.sort((left, right) => {
    const depthDiff = folderPathDepth(left.path) - folderPathDepth(right.path);
    if (depthDiff !== 0) return depthDiff;
    return left.path.localeCompare(right.path);
  });
}

export async function listIgnoredRemoteItems(
  drive,
  rootFolderId = null,
  ignoreRules,
  { includeSharedDrives = false } = {}
) {
  const { folders, files } = await fetchAllItems(drive, { includeSharedDrives });
  const items = buildRemoteItems(folders, files, rootFolderId);
  const ignored = [];

  for (const item of items) {
    if (!ignoreRules?.ignores?.(item.path)) continue;
    if (ignored.some((parent) => item.path.startsWith(`${parent.path}/`))) {
      continue;
    }
    ignored.push(item);
  }

  return ignored;
}

function buildDuplicateFolderGroups(folders, rootFolderId = null, ignoreRules = null) {
  const resolve = createFolderResolver(folders, rootFolderId);
  const groups = new Map();

  for (const folder of folders.values()) {
    if (isRemoteMemoItem(folder)) {
      continue;
    }
    const folderPath = resolve(folder.id);
    if (rootFolderId && folderPath === null) {
      continue;
    }
    if (ignoreRules && folderPath && ignoreRules.ignores(folderPath)) {
      continue;
    }

    const rawParentId = folder.parents?.[0] || "root";
    const parentPath =
      rawParentId === rootFolderId ? "" : resolve(folder.parents?.[0] || "");

    if (rootFolderId && parentPath === null) {
      continue;
    }

    const key = `${rawParentId}::${folder.name}`;
    const folderEntry = {
      ...folder,
      path: folderPath || folder.name,
    };

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        parentId: rawParentId,
        name: folder.name,
        path: parentPath ? path.posix.join(parentPath, folder.name) : folder.name,
        folders: [],
      });
    }

    groups.get(key).folders.push(folderEntry);
  }

  return [...groups.values()]
    .filter((group) => group.folders.length > 1)
    .map((group) => {
      const foldersInGroup = [...group.folders].sort(canonicalItemComparator);
      return {
        ...group,
        folders: foldersInGroup,
        canonical: foldersInGroup[0],
        losers: foldersInGroup.slice(1),
      };
    })
    .sort((left, right) => {
      const depthDiff = left.path.split("/").length - right.path.split("/").length;
      if (depthDiff !== 0) {
        return depthDiff;
      }
      return left.path.localeCompare(right.path);
    });
}

function fileModifiedTimeRank(file) {
  const parsed = Date.parse(file.modifiedTime || file.createdTime || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestFileComparator(left, right) {
  const modifiedDiff = fileModifiedTimeRank(right) - fileModifiedTimeRank(left);
  if (modifiedDiff !== 0) {
    return modifiedDiff;
  }

  const createdDiff = createdTimeRank(right) - createdTimeRank(left);
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return String(right.id || "").localeCompare(String(left.id || ""));
}

function buildDuplicateFileGroups(folders, rawFiles, rootFolderId = null, ignoreRules = null) {
  const resolve = createFolderResolver(folders, rootFolderId);
  const isOrphaned = createOrphanChecker(folders, rootFolderId);
  const groups = new Map();

  for (const file of rawFiles) {
    if (isRemoteMemoItem(file)) {
      continue;
    }
    const parentId = file.parents?.[0] || "";

    if (parentId && isOrphaned(parentId)) {
      continue;
    }

    const parentPath = parentId === rootFolderId ? "" : resolve(parentId);
    if (rootFolderId && parentPath === null) {
      continue;
    }

    const filePath = parentPath ? path.posix.join(parentPath, file.name) : file.name;
    if (ignoreRules && filePath && ignoreRules.ignores(filePath)) {
      continue;
    }

    const key = `${parentId || "root"}::${file.name}`;
    const fileEntry = {
      ...file,
      parentId: parentId || null,
      path: filePath,
    };

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        parentId: parentId || null,
        name: file.name,
        path: filePath,
        files: [],
      });
    }

    groups.get(key).files.push(fileEntry);
  }

  return [...groups.values()]
    .filter((group) => group.files.length > 1)
    .map((group) => {
      const filesInGroup = [...group.files].sort(latestFileComparator);
      return {
        ...group,
        files: filesInGroup,
        latest: filesInGroup[0],
        older: filesInGroup.slice(1),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function folderPathDepth(folderPath) {
  return String(folderPath || "")
    .split("/")
    .filter(Boolean).length;
}

export class DuplicateFoldersError extends Error {
  constructor(duplicateFolders) {
    const preview = duplicateFolders
      .slice(0, 5)
      .map(
        (group) =>
          `- ${group.path} (${group.folders.length}) canonical=${group.canonical.id}`
      )
      .join("\n");
    const suffix =
      duplicateFolders.length > 5
        ? `\n... and ${duplicateFolders.length - 5} more`
        : "";
    super(
      `Duplicate folders detected in the Drive sync root. Run 'aethel dedupe-folders' before syncing.\n${preview}${suffix}`
    );
    this.name = "DuplicateFoldersError";
    this.duplicateFolders = duplicateFolders;
  }
}

export async function getRemoteState(drive, rootFolderId = null, ignoreRules = null, options = {}) {
  let rawItems = null;
  let memoStartPageToken = null;
  let memoFileId = null;

  const memoResult = options.refreshRemoteMemo
    ? null
    : await fetchMemoizedRemoteItems(drive, rootFolderId, options);
  if (memoResult) {
    rawItems = memoResult.rawItems;
    memoStartPageToken = memoResult.startPageToken;
    memoFileId = memoResult.memoFileId;
  }

  if (!rawItems) {
    const startPageTokenPromise = remoteMemoEnabled(rootFolderId, options) && drive.changes
      ? getStartPageToken(drive).catch(() => null)
      : Promise.resolve(null);
    rawItems = await fetchRemoteItems(drive, rootFolderId, options);
    memoStartPageToken = await startPageTokenPromise;
  }

  if (memoStartPageToken) {
    await writeRemoteMemo(drive, rootFolderId, rawItems, memoStartPageToken, memoFileId, options)
      .catch((err) => {
        if (options.debugRemoteMemo) throw err;
      });
  }

  const { folders, files } = rawItems;
  return {
    files: buildRemoteFiles(folders, files, rootFolderId),
    duplicateFolders: buildDuplicateFolderGroups(folders, rootFolderId, ignoreRules),
  };
}

export async function listRemoteFiles(drive, rootFolderId = null) {
  const remoteState = await getRemoteState(drive, rootFolderId);
  return remoteState.files;
}

export async function findDuplicateFolders(drive, rootFolderId = null, ignoreRules = null) {
  const remoteState = await getRemoteState(drive, rootFolderId, ignoreRules);
  return remoteState.duplicateFolders;
}

export function assertNoDuplicateFolders(duplicateFolders) {
  if (duplicateFolders.length > 0) {
    throw new DuplicateFoldersError(duplicateFolders);
  }
}

export async function downloadFile(drive, fileMeta, localPath) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  const mime = fileMeta.mimeType || "";
  const exportInfo = EXPORT_MAP[mime];

  if (exportInfo) {
    let targetPath = localPath;
    if (!targetPath.endsWith(exportInfo.ext)) {
      const parsed = path.parse(targetPath);
      targetPath = path.join(parsed.dir, parsed.name + exportInfo.ext);
    }

    const response = await drive.files.export(
      { fileId: fileMeta.id, mimeType: exportInfo.mime, supportsAllDrives: true },
      { responseType: "stream" }
    );
    await pipeline(response.data, fs.createWriteStream(targetPath));
    // Exported files have no md5Checksum from Drive — skip verification
    return;
  }

  if (isWorkspaceType(mime)) {
    throw new Error(
      `Cannot download Google Workspace file '${fileMeta.name || fileMeta.id}' ` +
        `with unsupported mimeType '${mime}'`
    );
  }

  // Stream to disk while computing MD5 in parallel
  const { createHash } = await import("node:crypto");
  const md5 = createHash("md5");
  const writeStream = fs.createWriteStream(localPath);
  const response = await drive.files.get(
    { fileId: fileMeta.id, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );

  // Tee: pipe to both disk and hasher
  response.data.on("data", (chunk) => md5.update(chunk));
  await pipeline(response.data, writeStream);

  // Verify integrity if Drive provided an md5
  const expectedMd5 = fileMeta.md5Checksum;
  if (expectedMd5) {
    const actualMd5 = md5.digest("hex");
    if (actualMd5 !== expectedMd5) {
      // Remove corrupt file
      fs.unlinkSync(localPath);
      throw new Error(
        `Integrity check failed for ${fileMeta.name}: ` +
        `expected md5 ${expectedMd5}, got ${actualMd5}`
      );
    }
  }
}

export async function uploadFile(
  drive,
  localPath,
  remotePath,
  {
    parentId = null,
    existingId = null,
    cleanupDuplicates = false,
    childIndexCache = null,
  } = {}
) {
  const name = path.basename(remotePath);
  const makeMedia = () => ({ body: fs.createReadStream(localPath) });
  const targetParentId = parentId || "root";

  if (existingId) {
    try {
      const response = await drive.files.update({
        fileId: existingId,
        requestBody: { name },
        media: makeMedia(),
        supportsAllDrives: true,
        fields: "id,name,parents,md5Checksum,modifiedTime,size,mimeType",
      });
      if (cleanupDuplicates) {
        await trashDuplicateUploadTargets(
          drive,
          targetParentId,
          name,
          response.data.id,
          childIndexCache
        );
      }
      return response.data;
    } catch (err) {
      if (!isMissingDriveFileError(err)) {
        throw err;
      }
    }
  }

  if (cleanupDuplicates) {
    const existing = await findUploadTargetByName(
      drive,
      targetParentId,
      name,
      childIndexCache
    );
    if (existing) {
      const response = await drive.files.update({
        fileId: existing.id,
        requestBody: { name },
        media: makeMedia(),
        supportsAllDrives: true,
        fields: "id,name,parents,md5Checksum,modifiedTime,size,mimeType",
      });
      await trashDuplicateUploadTargets(drive, targetParentId, name, response.data.id);
      return response.data;
    }
  }

  const requestBody = { name };
  if (targetParentId) {
    requestBody.parents = [targetParentId];
  }

  const response = await drive.files.create({
    requestBody,
    media: makeMedia(),
    supportsAllDrives: true,
    fields: "id,name,parents,md5Checksum,modifiedTime,size,mimeType",
  });
  if (cleanupDuplicates) {
    await trashDuplicateUploadTargets(
      drive,
      targetParentId,
      name,
      response.data.id,
      childIndexCache
    );
  }
  return response.data;
}

function isMissingDriveFileError(err) {
  return err?.code === 404 || err?.response?.status === 404;
}

function isMissingLocalFileError(err) {
  return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

async function findUploadTargetByName(drive, parentId, name, childIndexCache = null) {
  const index = await getChildNameIndex(drive, parentId, childIndexCache);
  const matches = index
    ? index.get(name) || []
    : await listMatchingChildren(drive, parentId, name);
  return matches.find((item) => item.mimeType !== FOLDER_MIME) || null;
}

async function trashDuplicateUploadTargets(
  drive,
  parentId,
  name,
  keepId,
  childIndexCache = null
) {
  const index = await getChildNameIndex(drive, parentId, childIndexCache);
  const matches = index
    ? index.get(name) || []
    : await listMatchingChildren(drive, parentId, name);
  const duplicates = matches.filter(
    (item) => item.id !== keepId && item.mimeType !== FOLDER_MIME
  );

  await Promise.all(duplicates.map((item) => trashFile(drive, item.id)));
}

const _folderIdCache = new Map();
const _folderPromiseCache = new Map();

export function resetFolderLookupCache() {
  _folderIdCache.clear();
  _folderPromiseCache.clear();
}

async function listMatchingChildren(drive, parentId, name, mimeType = null) {
  const escapedName = escapeDriveQueryValue(name);
  const queryParts = [
    `name = '${escapedName}'`,
    `'${parentId}' in parents`,
    "trashed = false",
  ];

  if (mimeType) {
    queryParts.push(`mimeType = '${mimeType}'`);
  }

  let pageToken = null;
  const items = [];

  do {
    const response = await drive.files.list({
      q: queryParts.join(" and "),
      fields: CHILD_QUERY_FIELDS,
      pageSize: PAGE_SIZE,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    items.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return items.sort(canonicalItemComparator);
}

function createChildNameIndex(items) {
  const index = new Map();

  for (const item of items) {
    if (!index.has(item.name)) {
      index.set(item.name, []);
    }
    index.get(item.name).push(item);
  }

  for (const groupedItems of index.values()) {
    groupedItems.sort(canonicalItemComparator);
  }

  return index;
}

async function getChildNameIndex(drive, parentId, childIndexCache = null) {
  if (!childIndexCache) {
    return null;
  }

  let pending = childIndexCache.get(parentId);
  if (!pending) {
    pending = listDirectChildren(drive, parentId).then((items) =>
      createChildNameIndex(items)
    );
    childIndexCache.set(parentId, pending);
  }

  return pending;
}

async function getIndexedChild(
  drive,
  parentId,
  name,
  mimeType = null,
  childIndexCache = null
) {
  if (!childIndexCache) {
    return undefined;
  }

  const index = await getChildNameIndex(drive, parentId, childIndexCache);
  const candidates = (index.get(name) || []).filter(
    (item) => !mimeType || item.mimeType === mimeType
  );
  return pickCanonicalItem(candidates) || null;
}

async function resolveCanonicalFolder(
  drive,
  parentId,
  name,
  createIfMissing = true,
  { childIndexCache = null } = {}
) {
  const cacheKey = `${parentId}/${name}`;
  const cachedId = _folderIdCache.get(cacheKey);
  if (cachedId) {
    return {
      id: cachedId,
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    };
  }

  const pending = _folderPromiseCache.get(cacheKey);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const indexedExisting = await getIndexedChild(
      drive,
      parentId,
      name,
      FOLDER_MIME,
      childIndexCache
    );
    const existing = indexedExisting !== undefined
      ? indexedExisting
        ? [indexedExisting]
        : []
      : await listMatchingChildren(drive, parentId, name, FOLDER_MIME);
    const canonical = pickCanonicalItem(existing);

    if (canonical) {
      _folderIdCache.set(cacheKey, canonical.id);
      return canonical;
    }

    if (!createIfMissing) {
      return null;
    }

    const created = await createFolder(drive, name, parentId);
    _folderIdCache.set(cacheKey, created.id);
    return created;
  })().finally(() => {
    _folderPromiseCache.delete(cacheKey);
  });

  _folderPromiseCache.set(cacheKey, promise);
  return promise;
}

export async function ensureFolder(drive, folderPath, rootId = null) {
  const parts = folderPath.split("/").filter(Boolean);
  let parent = rootId || "root";

  for (const part of parts) {
    const folder = await resolveCanonicalFolder(drive, parent, part, true);
    parent = folder.id;
  }

  return parent;
}

export async function findRemoteItemByPath(drive, remotePath, rootId = null) {
  const parts = String(remotePath || "").split("/").filter(Boolean);
  if (!parts.length) {
    return null;
  }

  let parent = rootId || "root";

  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    const item = isLast
      ? pickCanonicalItem(await listMatchingChildren(drive, parent, part))
      : await resolveCanonicalFolder(drive, parent, part, false);

    if (!item) {
      return null;
    }

    if (!isLast) {
      parent = item.id;
    } else {
      return item;
    }
  }

  return null;
}

export async function trashFile(drive, fileId) {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

export async function deleteFile(drive, fileId) {
  await drive.files.delete({ fileId, supportsAllDrives: true });
}

export async function getAccountInfo(drive) {
  const response = await drive.about.get({
    fields: "user(emailAddress, displayName), storageQuota(usage, limit)",
  });
  const user = response.data.user || {};
  const quota = response.data.storageQuota || {};

  return {
    email: user.emailAddress || "unknown",
    name: user.displayName || "unknown",
    usage: humanSize(quota.usage),
    limit: humanSize(quota.limit),
  };
}

export async function listRootFolders(drive) {
  const items = [];
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'root' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "nextPageToken, files(id, name, modifiedTime)",
      pageSize: PAGE_SIZE,
      pageToken,
    });
    items.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAccessibleFiles(drive, includeSharedDrives = false) {
  const richFields =
    "nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, ownedByMe, shared, driveId, owners(displayName,emailAddress), capabilities(canAddChildren,canEdit,canTrash,canDelete,canRename))";

  const { folders, files: rawItems } = await fetchAllItems(drive, {
    fields: richFields,
    includeSharedDrives,
  });

  const resolveFolderPath = createFolderResolver(folders, null);
  const isOrphaned = createOrphanChecker(folders);

  // Combine folders + files into result list (TUI needs folders too)
  // Filter out orphaned items (children of trashed folders)
  const allItems = [...folders.values(), ...rawItems];
  const result = [];

  for (const file of allItems) {
    const parentId = file.parents?.[0] || "";

    // Skip orphaned items (children of trashed folders)
    if (parentId && isOrphaned(parentId)) continue;

    const parentPath = resolveFolderPath(parentId) || "";
    const itemPath = parentPath
      ? path.posix.join(parentPath, file.name)
      : file.name;

    result.push({
      ...file,
      parentId: parentId || null,
      path: itemPath,
      isFolder: file.mimeType === FOLDER_MIME,
      isRootLevel: !parentId || !folders.has(parentId),
      ownedByMe: Boolean(file.ownedByMe),
      shared: Boolean(file.shared),
      isSharedDriveItem: Boolean(file.driveId),
      ownerName: file.owners?.[0]?.displayName || null,
      ownerEmail: file.owners?.[0]?.emailAddress || null,
      capabilities: file.capabilities || {},
    });
  }

  return result;
}

export async function batchOperateFiles(
  drive,
  files,
  { permanent = false, includeSharedDrives = false, onProgress } = {}
) {
  let success = 0;
  let errors = 0;
  const total = files.length;

  for (let start = 0; start < total; start += CLEANER_BATCH_SIZE) {
    const chunk = files.slice(start, start + CLEANER_BATCH_SIZE);
    const results = await Promise.allSettled(
      chunk.map(async (file) => {
        if (permanent) {
          await drive.files.delete({
            fileId: file.id,
            supportsAllDrives: includeSharedDrives,
          });
          return { verb: "Deleted", name: file.name };
        }

        await drive.files.update({
          fileId: file.id,
          requestBody: { trashed: true },
          supportsAllDrives: includeSharedDrives,
        });
        return { verb: "Trashed", name: file.name };
      })
    );

    for (const [index, result] of results.entries()) {
      const file = chunk[index];

      if (result.status === "fulfilled") {
        success += 1;
        onProgress?.(success + errors, total, result.value.verb, file.name);
        continue;
      }

      errors += 1;
      onProgress?.(success + errors, total, "FAILED", file.name);
    }
  }

  return { success, errors };
}

export async function createFolder(drive, name, parentId = "root") {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: parentId ? [parentId] : undefined,
    },
    supportsAllDrives: true,
    fields: "id,name,mimeType,parents,createdTime,modifiedTime",
  });

  return response.data;
}

export async function findChildrenByName(drive, parentId, name, mimeType = null) {
  return listMatchingChildren(drive, parentId, name, mimeType);
}

export async function findChildByName(drive, parentId, name, mimeType = null) {
  const matches = await listMatchingChildren(drive, parentId, name, mimeType);
  return matches[0] || null;
}

async function listDirectChildren(drive, parentId) {
  let pageToken = null;
  const items = [];

  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: CHILD_QUERY_FIELDS,
      pageSize: PAGE_SIZE,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    items.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return items;
}

async function moveItemToParent(drive, item, fromParentId, toParentId) {
  const response = await drive.files.update({
    fileId: item.id,
    addParents: toParentId,
    removeParents: fromParentId,
    requestBody: {},
    supportsAllDrives: true,
    fields: "id,name,mimeType,parents,createdTime,modifiedTime,md5Checksum,size",
  });
  return response.data;
}

function filesHaveSameContent(left, right) {
  return Boolean(
    left.mimeType === right.mimeType &&
      left.md5Checksum &&
      right.md5Checksum &&
      left.md5Checksum === right.md5Checksum
  );
}

function createUploadContext(localPath) {
  const workspaceRoot = findRoot(localPath);
  return {
    workspaceRoot,
    ignoreRules: workspaceRoot ? loadIgnoreRules(workspaceRoot) : null,
    parentMetaCache: new Map(),
    childIndexCache: new Map(),
  };
}

function shouldIgnoreUploadPath(targetPath, isDirectory, context) {
  if (!context?.workspaceRoot || !context.ignoreRules) {
    return false;
  }

  let relativePath = path
    .relative(context.workspaceRoot, targetPath)
    .split(path.sep)
    .join("/");

  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  if (isDirectory && !relativePath.endsWith("/")) {
    relativePath += "/";
  }

  return context.ignoreRules.ignores(relativePath);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

function createChildState(items) {
  return {
    items: [...items],
    byName: createChildNameIndex(items),
  };
}

async function getChildState(drive, parentId, childStateCache) {
  let statePromise = childStateCache.get(parentId);
  if (!statePromise) {
    statePromise = listDirectChildren(drive, parentId).then((items) =>
      createChildState(items)
    );
    childStateCache.set(parentId, statePromise);
  }

  return statePromise;
}

function addToChildState(state, item) {
  state.items.push(item);
  const groupedItems = state.byName.get(item.name) || [];
  groupedItems.push(item);
  groupedItems.sort(canonicalItemComparator);
  state.byName.set(item.name, groupedItems);
}

function removeFromChildState(state, itemId) {
  const index = state.items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return null;
  }

  const [removed] = state.items.splice(index, 1);
  const groupedItems = (state.byName.get(removed.name) || []).filter(
    (item) => item.id !== itemId
  );

  if (groupedItems.length > 0) {
    state.byName.set(removed.name, groupedItems);
  } else {
    state.byName.delete(removed.name);
  }

  return removed;
}

function findMatchingChild(state, name, mimeType = null) {
  const candidates = (state.byName.get(name) || []).filter(
    (item) => !mimeType || item.mimeType === mimeType
  );
  return pickCanonicalItem(candidates);
}

function createDedupeContext() {
  return {
    childStateCache: new Map(),
    trashedFolderIds: new Set(),
  };
}

function groupItemsByName(items) {
  const groups = new Map();

  for (const item of items) {
    if (!groups.has(item.name)) {
      groups.set(item.name, []);
    }
    groups.get(item.name).push(item);
  }

  return [...groups.values()];
}

async function mergeFolderIntoCanonical(
  drive,
  sourceFolder,
  targetFolder,
  stats,
  onProgress = null,
  context = createDedupeContext()
) {
  if (
    context.trashedFolderIds.has(sourceFolder.id) ||
    context.trashedFolderIds.has(targetFolder.id)
  ) {
    return;
  }

  const sourceState = await getChildState(
    drive,
    sourceFolder.id,
    context.childStateCache
  );
  const targetState = await getChildState(
    drive,
    targetFolder.id,
    context.childStateCache
  );
  const childGroups = groupItemsByName([...sourceState.items]);

  await mapWithConcurrency(
    childGroups,
    DEDUPE_BATCH_SIZE,
    async (group) => {
      for (const child of group) {
        if (!sourceState.items.some((item) => item.id === child.id)) {
          continue;
        }

        if (child.mimeType === FOLDER_MIME) {
          const existingFolder = findMatchingChild(
            targetState,
            child.name,
            FOLDER_MIME
          );

          if (existingFolder) {
            await mergeFolderIntoCanonical(
              drive,
              child,
              existingFolder,
              stats,
              onProgress,
              context
            );
            continue;
          }

          const movedChild = await moveItemToParent(
            drive,
            child,
            sourceFolder.id,
            targetFolder.id
          );
          removeFromChildState(sourceState, child.id);
          addToChildState(targetState, movedChild);
          stats.movedItems += 1;
          onProgress?.({
            type: "move",
            itemType: "folder",
            path: child.name,
            sourceId: sourceFolder.id,
            targetId: targetFolder.id,
          });
          continue;
        }

        const existing = findMatchingChild(targetState, child.name);

        if (!existing) {
          const movedChild = await moveItemToParent(
            drive,
            child,
            sourceFolder.id,
            targetFolder.id
          );
          removeFromChildState(sourceState, child.id);
          addToChildState(targetState, movedChild);
          stats.movedItems += 1;
          onProgress?.({
            type: "move",
            itemType: "file",
            path: child.name,
            sourceId: sourceFolder.id,
            targetId: targetFolder.id,
          });
          continue;
        }

        if (
          existing.mimeType === FOLDER_MIME ||
          !filesHaveSameContent(existing, child)
        ) {
          stats.skippedConflicts += 1;
          onProgress?.({
            type: "skip_conflict",
            path: child.name,
            sourceId: sourceFolder.id,
            targetId: targetFolder.id,
          });
          continue;
        }

        await trashFile(drive, child.id);
        removeFromChildState(sourceState, child.id);
        stats.trashedDuplicateFiles += 1;
        onProgress?.({
          type: "trash_duplicate_file",
          path: child.name,
          fileId: child.id,
        });
      }
    }
  );

  if (sourceState.items.length === 0) {
    await trashFile(drive, sourceFolder.id);
    context.trashedFolderIds.add(sourceFolder.id);
    const parentId = sourceFolder.parents?.[0];
    if (parentId) {
      const parentState = await getChildState(
        drive,
        parentId,
        context.childStateCache
      );
      removeFromChildState(parentState, sourceFolder.id);
    }
    stats.trashedFolders += 1;
    onProgress?.({
      type: "trash_folder",
      path: sourceFolder.name,
      folderId: sourceFolder.id,
    });
  }
}

export async function dedupeDuplicateFolders(
  drive,
  rootFolderId = null,
  { execute = false, onProgress = null, ignoreRules = null } = {}
) {
  const stats = {
    duplicatePaths: 0,
    movedItems: 0,
    skippedConflicts: 0,
    trashedDuplicateFiles: 0,
    trashedFolders: 0,
  };

  const { folders } = await fetchAllItems(drive);
  const initialGroups = buildDuplicateFolderGroups(folders, rootFolderId, ignoreRules);
  stats.duplicatePaths = initialGroups.length;

  if (!execute || initialGroups.length === 0) {
    return {
      ...stats,
      duplicateFolders: initialGroups,
      remainingDuplicateFolders: initialGroups,
    };
  }
  const executionGroups = [...initialGroups].sort((left, right) => {
    const depthDiff = folderPathDepth(right.path) - folderPathDepth(left.path);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return left.path.localeCompare(right.path);
  });
  const context = createDedupeContext();

  // Partition groups by depth level for inter-group parallelism.
  // Groups at the same depth target different parent folders, so they
  // can be processed concurrently.  Deepest-first ordering guarantees
  // sub-duplicates are resolved before parent-level merges begin.
  const byDepth = new Map();
  for (const group of executionGroups) {
    const depth = folderPathDepth(group.path);
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push(group);
  }
  const depths = [...byDepth.keys()].sort((a, b) => b - a);

  for (const depth of depths) {
    const levelGroups = byDepth.get(depth);
    const tasks = levelGroups.map((group) => async () => {
      if (context.trashedFolderIds.has(group.canonical.id)) {
        return;
      }
      for (const loser of group.losers) {
        if (context.trashedFolderIds.has(loser.id)) {
          continue;
        }
        await mergeFolderIntoCanonical(
          drive,
          loser,
          group.canonical,
          stats,
          onProgress,
          context
        );
      }
    });
    await mapWithConcurrency(tasks, DEDUPE_BATCH_SIZE, (task) => task());
  }

  const remainingDuplicateFolders = await findDuplicateFolders(drive, rootFolderId, ignoreRules);

  return {
    ...stats,
    duplicateFolders: initialGroups,
    remainingDuplicateFolders,
  };
}

export async function findDuplicateFiles(drive, rootFolderId = null, ignoreRules = null) {
  const { folders, files } = await fetchAllItems(drive);
  return buildDuplicateFileGroups(folders, files, rootFolderId, ignoreRules);
}

export async function dedupeDuplicateFiles(
  drive,
  rootFolderId = null,
  { execute = false, onProgress = null, ignoreRules = null } = {}
) {
  const stats = {
    duplicatePaths: 0,
    keptFiles: 0,
    trashedFiles: 0,
    errors: [],
  };

  const { folders, files } = await fetchAllItems(drive);
  const initialGroups = buildDuplicateFileGroups(folders, files, rootFolderId, ignoreRules);
  stats.duplicatePaths = initialGroups.length;
  stats.keptFiles = initialGroups.length;

  if (!execute || initialGroups.length === 0) {
    return {
      ...stats,
      duplicateFiles: initialGroups,
      remainingDuplicateFiles: initialGroups,
    };
  }

  const olderFiles = initialGroups.flatMap((group) =>
    group.older.map((file) => ({ group, file }))
  );

  await mapWithConcurrency(olderFiles, DEDUPE_BATCH_SIZE, async ({ group, file }) => {
    try {
      await trashFile(drive, file.id);
      stats.trashedFiles += 1;
      onProgress?.({
        type: "trash_duplicate_file",
        path: group.path,
        fileId: file.id,
        keptFileId: group.latest.id,
      });
    } catch (err) {
      const error = {
        path: group.path,
        fileId: file.id,
        message: err.message,
      };
      stats.errors.push(error);
      onProgress?.({
        type: "error",
        ...error,
      });
    }
  });

  const remainingDuplicateFiles = await findDuplicateFiles(drive, rootFolderId, ignoreRules);

  return {
    ...stats,
    duplicateFiles: initialGroups,
    remainingDuplicateFiles,
  };
}

export async function getRemoteItemMeta(drive, fileId) {
  if (!fileId || fileId === "root") {
    return {
      id: "root",
      name: "My Drive",
      capabilities: {
        canAddChildren: true,
        canEdit: true,
      },
    };
  }

  const response = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields:
      "id,name,mimeType,capabilities(canAddChildren,canEdit,canTrash,canDelete,canRename)",
  });

  return response.data;
}

async function assertParentWritable(drive, parentId, parentMetaCache = null) {
  let parentMetaPromise = parentMetaCache?.get(parentId);
  if (!parentMetaPromise) {
    parentMetaPromise = getRemoteItemMeta(drive, parentId);
    parentMetaCache?.set(parentId, parentMetaPromise);
  }

  const parentMeta = await parentMetaPromise;
  if (parentMeta.capabilities?.canAddChildren === false) {
    throw new Error(
      `No permission to upload into "${parentMeta.name}". This folder does not allow adding children.`
    );
  }
  return parentMeta;
}

async function uploadLocalFileToParent(
  drive,
  localPath,
  parentId,
  onProgress = null,
  context = null
) {
  const fileName = path.basename(localPath);
  await assertParentWritable(drive, parentId, context?.parentMetaCache);
  const indexedExisting = await getIndexedChild(
    drive,
    parentId,
    fileName,
    null,
    context?.childIndexCache
  );
  const existing =
    indexedExisting !== undefined
      ? indexedExisting
      : await findChildByName(drive, parentId, fileName);

  if (
    existing &&
    existing.mimeType !== "application/vnd.google-apps.folder" &&
    existing.capabilities?.canEdit === false
  ) {
    throw new Error(
      `No permission to overwrite existing file "${fileName}" in the target folder.`
    );
  }

  onProgress?.("upload", localPath, fileName);
  try {
    await uploadFile(drive, localPath, fileName, {
      parentId,
      existingId:
        existing && existing.mimeType !== "application/vnd.google-apps.folder"
          ? existing.id
          : null,
    });
  } catch (err) {
    if (isMissingLocalFileError(err)) {
      onProgress?.("skip", localPath, fileName);
      return { uploadedFiles: 0, uploadedDirectories: 0 };
    }
    throw err;
  }

  return { uploadedFiles: 1, uploadedDirectories: 0 };
}

async function uploadLocalDirectoryToParent(
  drive,
  localPath,
  parentId,
  onProgress = null,
  context = createUploadContext(localPath)
) {
  const directoryName = path.basename(localPath);
  await assertParentWritable(drive, parentId, context.parentMetaCache);
  const existingFolder = await resolveCanonicalFolder(
    drive,
    parentId,
    directoryName,
    false,
    { childIndexCache: context.childIndexCache }
  );
  let targetFolder = existingFolder;

  if (!targetFolder) {
    onProgress?.("mkdir", localPath, directoryName);
    targetFolder = await resolveCanonicalFolder(
      drive,
      parentId,
      directoryName,
      true,
      { childIndexCache: context.childIndexCache }
    );
  }

  const entries = (await fs.promises.readdir(localPath, { withFileTypes: true })).filter(
    (entry) => {
      if (entry.name.startsWith(".")) {
        return false;
      }
      return !shouldIgnoreUploadPath(
        path.join(localPath, entry.name),
        entry.isDirectory(),
        context
      );
    }
  );
  let uploadedFiles = 0;
  let uploadedDirectories = 1;

  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  const directoryResults = await mapWithConcurrency(
    directories,
    UPLOAD_BATCH_SIZE,
    async (entry) =>
      uploadLocalDirectoryToParent(
        drive,
        path.join(localPath, entry.name),
        targetFolder.id,
        onProgress,
        context
      )
  );

  for (const nestedResult of directoryResults) {
    uploadedFiles += nestedResult.uploadedFiles;
    uploadedDirectories += nestedResult.uploadedDirectories;
  }

  const fileResults = await mapWithConcurrency(
    files,
    UPLOAD_BATCH_SIZE,
    async (entry) =>
      uploadLocalFileToParent(
        drive,
        path.join(localPath, entry.name),
        targetFolder.id,
        onProgress,
        context
      )
  );

  for (const fileResult of fileResults) {
    uploadedFiles += fileResult.uploadedFiles;
  }

  return { uploadedFiles, uploadedDirectories };
}

async function syncLocalDirectoryContentsToParent(
  drive,
  localPath,
  parentId,
  onProgress = null,
  context = createUploadContext(localPath)
) {
  const resolvedPath = path.resolve(localPath);
  await assertParentWritable(drive, parentId, context.parentMetaCache);
  const entries = (await fs.promises.readdir(resolvedPath, { withFileTypes: true })).filter(
    (entry) => {
      if (entry.name.startsWith(".")) {
        return false;
      }
      return !shouldIgnoreUploadPath(
        path.join(resolvedPath, entry.name),
        entry.isDirectory(),
        context
      );
    }
  );
  let uploadedFiles = 0;
  let uploadedDirectories = 0;

  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  const directoryResults = await mapWithConcurrency(
    directories,
    UPLOAD_BATCH_SIZE,
    async (entry) => {
      const childPath = path.join(resolvedPath, entry.name);
      let targetFolder = await resolveCanonicalFolder(
        drive,
        parentId,
        entry.name,
        false,
        { childIndexCache: context.childIndexCache }
      );

      if (!targetFolder) {
        onProgress?.("mkdir", childPath, entry.name);
        targetFolder = await resolveCanonicalFolder(
          drive,
          parentId,
          entry.name,
          true,
          { childIndexCache: context.childIndexCache }
        );
      }

      const nestedResult = await syncLocalDirectoryContentsToParent(
        drive,
        childPath,
        targetFolder.id,
        onProgress,
        context
      );

      return {
        uploadedFiles: nestedResult.uploadedFiles,
        uploadedDirectories: nestedResult.uploadedDirectories + 1,
      };
    }
  );

  for (const nestedResult of directoryResults) {
    uploadedFiles += nestedResult.uploadedFiles;
    uploadedDirectories += nestedResult.uploadedDirectories;
  }

  const fileResults = await mapWithConcurrency(
    files,
    UPLOAD_BATCH_SIZE,
    async (entry) =>
      uploadLocalFileToParent(
        drive,
        path.join(resolvedPath, entry.name),
        parentId,
        onProgress,
        context
      )
  );

  for (const fileResult of fileResults) {
    uploadedFiles += fileResult.uploadedFiles;
  }

  return { uploadedFiles, uploadedDirectories };
}

export async function uploadLocalEntry(
  drive,
  localPath,
  parentId = "root",
  onProgress = null
) {
  const resolvedPath = path.resolve(localPath);
  const stat = await fs.promises.stat(resolvedPath);

  if (stat.isDirectory()) {
    return uploadLocalDirectoryToParent(drive, resolvedPath, parentId, onProgress);
  }

  if (stat.isFile()) {
    return uploadLocalFileToParent(drive, resolvedPath, parentId, onProgress);
  }

  throw new Error(`Unsupported local path type: ${resolvedPath}`);
}

export async function syncLocalDirectoryToParent(
  drive,
  localPath,
  parentId = "root",
  onProgress = null
) {
  const resolvedPath = path.resolve(localPath);
  const stat = await fs.promises.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error(`Local path is not a directory: ${resolvedPath}`);
  }

  return syncLocalDirectoryContentsToParent(
    drive,
    resolvedPath,
    parentId,
    onProgress
  );
}
