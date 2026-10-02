import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export function folder(id, name, parentId, createdTime) {
  return {
    id,
    name,
    mimeType: FOLDER_MIME,
    parents: parentId ? [parentId] : [],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum: null,
    size: null,
    capabilities: {
      canAddChildren: true,
      canEdit: true,
      canTrash: true,
      canDelete: true,
      canRename: true,
    },
    trashed: false,
  };
}

export function file(id, name, parentId, createdTime, md5Checksum) {
  return {
    id,
    name,
    mimeType: "application/octet-stream",
    parents: [parentId],
    createdTime,
    modifiedTime: createdTime,
    md5Checksum,
    size: 1,
    capabilities: {
      canAddChildren: false,
      canEdit: true,
      canTrash: true,
      canDelete: true,
      canRename: true,
    },
    trashed: false,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

export function createFakeDrive(initialItems = [], { listDelayMs = 0 } = {}) {
  const items = new Map(initialItems.map((item) => [item.id, clone(item)]));
  let sequence = 0;
  let idCounter = 1000;
  let changeSequence = 0;
  const changesLog = [];
  const listQueries = [];

  function recordChange(item, removed = false) {
    changesLog.push({
      seq: ++changeSequence,
      fileId: item.id,
      removed,
      file: removed ? undefined : clone(item),
    });
  }

  function decodeQueryValue(value) {
    return value.replace(/\\\\/g, "\\").replace(/\\'/g, "'");
  }

  function matches(item, query) {
    if (!query) {
      return true;
    }

    return query.split(" and ").every((part) => {
      if (part === "trashed = false") {
        return !item.trashed;
      }

      const nameMatch = part.match(/^name = '(.+)'$/);
      if (nameMatch) {
        return item.name === decodeQueryValue(nameMatch[1]);
      }

      const mimeMatch = part.match(/^mimeType = '(.+)'$/);
      if (mimeMatch) {
        return item.mimeType === decodeQueryValue(mimeMatch[1]);
      }

      const mimeExclusionMatch = part.match(/^mimeType != '(.+)'$/);
      if (mimeExclusionMatch) {
        return item.mimeType !== decodeQueryValue(mimeExclusionMatch[1]);
      }

      const parentMatch = part.match(/^'(.+)' in parents$/);
      if (parentMatch) {
        return (item.parents || []).includes(parentMatch[1]);
      }

      return true;
    });
  }

  async function drain(stream) {
    if (!stream) {
      return Buffer.alloc(0);
    }

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function touch(item) {
    item.modifiedTime = new Date(1700000000000 + sequence++).toISOString();
  }

  return {
    files: {
      async list({ q, pageSize = 1000, pageToken, orderBy }) {
        if (listDelayMs) {
          await delay(listDelayMs);
        }

        listQueries.push(q || "");

        const matchesQuery = [...items.values()].filter((item) => matches(item, q));
        matchesQuery.sort((left, right) => {
          if (orderBy === "createdTime desc") {
            return Date.parse(right.createdTime) - Date.parse(left.createdTime);
          }
          return String(left.id).localeCompare(String(right.id));
        });

        const start = Number(pageToken || 0);
        const slice = matchesQuery.slice(start, start + pageSize).map(clone);
        const nextPageToken =
          start + pageSize < matchesQuery.length ? String(start + pageSize) : undefined;

        return {
          data: {
            files: slice,
            nextPageToken,
          },
        };
      },
      async create({ requestBody, media }) {
        const body = await drain(media?.body);
        const id = `id-${++idCounter}`;
        const createdTime = new Date(1700000000000 + sequence++).toISOString();
        const item = {
          id,
          name: requestBody.name,
          mimeType: requestBody.mimeType || "application/octet-stream",
          parents: requestBody.parents || [],
          createdTime,
          modifiedTime: createdTime,
          md5Checksum: requestBody.mimeType === FOLDER_MIME ? null : md5(body),
          size: requestBody.mimeType === FOLDER_MIME ? null : body.length,
          capabilities: {
            canAddChildren: true,
            canEdit: true,
            canTrash: true,
            canDelete: true,
            canRename: true,
          },
          trashed: false,
          _body: body.toString("utf8"),
        };
        items.set(id, item);
        recordChange(item);
        return { data: clone(item) };
      },
      async update({ fileId, requestBody = {}, addParents, removeParents, media }) {
        const body = await drain(media?.body);
        const item = items.get(fileId);

        if (!item) {
          const err = new Error(`File not found: ${fileId}`);
          err.code = 404;
          throw err;
        }

        if (requestBody.name) {
          item.name = requestBody.name;
        }

        if (Object.hasOwn(requestBody, "trashed")) {
          item.trashed = Boolean(requestBody.trashed);
        }

        if (addParents || removeParents) {
          const nextParents = new Set(item.parents || []);
          for (const parentId of String(removeParents || "")
            .split(",")
            .filter(Boolean)) {
            nextParents.delete(parentId);
          }
          if (addParents) {
            nextParents.add(addParents);
          }
          item.parents = [...nextParents];
        }

        if (body.length && item.mimeType !== FOLDER_MIME) {
          item._body = body.toString("utf8");
          item.md5Checksum = md5(body);
          item.size = body.length;
        }

        touch(item);
        recordChange(item);
        return { data: clone(item) };
      },
      async delete({ fileId }) {
        const item = items.get(fileId);
        items.delete(fileId);
        if (item) {
          recordChange(item, true);
        }
        return { data: {} };
      },
      async get({ fileId, alt }) {
        if (fileId === "root") {
          return {
            data: {
              id: "root",
              name: "My Drive",
              mimeType: FOLDER_MIME,
              parents: [],
              capabilities: {
                canAddChildren: true,
                canEdit: true,
              },
            },
          };
        }

        if (alt === "media") {
          return { data: Readable.from([items.get(fileId)?._body || ""]) };
        }

        return { data: clone(items.get(fileId)) };
      },
    },
    changes: {
      async getStartPageToken() {
        return { data: { startPageToken: String(changeSequence) } };
      },
      async list({ pageToken }) {
        const since = Number(pageToken || 0);
        return {
          data: {
            changes: changesLog
              .filter((change) => change.seq > since)
              .map(({ seq, ...change }) => clone(change)),
            newStartPageToken: String(changeSequence),
          },
        };
      },
    },
    snapshot() {
      return [...items.values()]
        .map(clone)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    },
    listQueries() {
      return [...listQueries];
    },
    clearListQueries() {
      listQueries.length = 0;
    },
  };
}

