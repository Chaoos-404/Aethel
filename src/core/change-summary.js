import path from "node:path";

function parentPath(changePath) {
  const normalized = String(changePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "." : parent;
}

function sameValue(values) {
  return values.every((value) => value === values[0]);
}

function summaryStatus(changes) {
  const statuses = changes.map((change) => change.shortStatus);
  return sameValue(statuses) ? statuses[0] : "..";
}

function summaryDescription(changes) {
  const descriptions = changes.map((change) => change.description);
  if (sameValue(descriptions)) {
    return `${changes.length} changes: ${descriptions[0]}`;
  }
  return `${changes.length} changes`;
}

function makeChangeEntry(change, order) {
  return {
    kind: "change",
    order,
    path: change.path,
    shortStatus: change.shortStatus,
    description: change.description,
    count: 1,
    changes: [change],
    change,
  };
}

function makeGroupEntry(parent, changes, order) {
  return {
    kind: "group",
    order,
    path: parent === "." ? "." : `${parent}/`,
    shortStatus: summaryStatus(changes),
    description: summaryDescription(changes),
    count: changes.length,
    changes,
  };
}

function pathPrefixes(pathValue) {
  const parts = String(pathValue || "").split("/").filter(Boolean);
  const prefixes = [];
  for (let i = 1; i < parts.length; i++) {
    prefixes.push(parts.slice(0, i).join("/"));
  }
  return prefixes;
}

function isDeletionAction(action) {
  return action === "delete_local" || action === "delete_remote";
}

function isUnder(pathValue, parent) {
  return pathValue === parent || pathValue.startsWith(`${parent}/`);
}

function makeStagedChangeEntry(entry, order) {
  return {
    kind: "change",
    order,
    path: entry.path,
    action: entry.action,
    description: entry.action,
    count: 1,
    entries: [entry],
    entry,
  };
}

function makeStagedGroupEntry(parent, entries, order) {
  return {
    kind: "group",
    order,
    path: parent === "." ? "." : `${parent}/`,
    action: entries[0]?.action || "",
    description: `${entries.length} changes`,
    count: entries.length,
    entries,
  };
}

function selectLargeDeletionGroups(entries, { minCount = 8, minDepth = 2 } = {}) {
  const selected = [];
  const byAction = new Map();

  for (const [order, entry] of entries.entries()) {
    if (!isDeletionAction(entry.action)) {
      continue;
    }

    const actionGroup = byAction.get(entry.action) || [];
    actionGroup.push({ ...entry, order });
    byAction.set(entry.action, actionGroup);
  }

  for (const actionEntries of byAction.values()) {
    const candidates = new Map();

    for (const entry of actionEntries) {
      for (const prefix of pathPrefixes(entry.path)) {
        const depth = prefix.split("/").length;
        if (depth < minDepth) {
          continue;
        }

        const candidate = candidates.get(prefix) || {
          path: prefix,
          order: entry.order,
          entries: [],
        };
        candidate.entries.push(entry);
        candidate.order = Math.min(candidate.order, entry.order);
        candidates.set(prefix, candidate);
      }
    }

    const sorted = [...candidates.values()]
      .filter((candidate) => candidate.entries.length >= minCount)
      .sort((left, right) => {
        const orderDelta = left.order - right.order;
        if (orderDelta !== 0) {
          return orderDelta;
        }
        return left.path.split("/").length - right.path.split("/").length;
      });

    for (const candidate of sorted) {
      if (selected.some((group) => isUnder(candidate.path, group.path))) {
        continue;
      }

      selected.push(candidate);
    }
  }

  return selected;
}

export function summarizeChanges(changes, { detail = false } = {}) {
  if (detail) {
    return changes.map((change, order) => makeChangeEntry(change, order));
  }

  const groups = new Map();
  for (const [order, change] of changes.entries()) {
    const parent = parentPath(change.path);
    const group = groups.get(parent) || { parent, order, changes: [] };
    group.changes.push(change);
    groups.set(parent, group);
  }

  const entries = [];
  for (const group of groups.values()) {
    if (group.parent !== "." && group.changes.length > 1) {
      entries.push(makeGroupEntry(group.parent, group.changes, group.order));
      continue;
    }

    for (const change of group.changes) {
      entries.push(makeChangeEntry(change, group.order));
      group.order += 0.001;
    }
  }

  return entries.sort((left, right) => left.order - right.order);
}

export function summarizeStagedEntries(staged, { detail = false } = {}) {
  if (detail) {
    return staged.map((entry, order) => makeStagedChangeEntry(entry, order));
  }

  const largeGroups = selectLargeDeletionGroups(staged);
  const covered = new Set();
  const entries = [];

  for (const group of largeGroups) {
    const stagedEntries = group.entries.map(({ order, ...entry }) => entry);
    entries.push(makeStagedGroupEntry(group.path, stagedEntries, group.order));
    for (const entry of group.entries) {
      covered.add(`${entry.action}\0${entry.path}`);
    }
  }

  const smallGroups = new Map();
  for (const [order, entry] of staged.entries()) {
    if (covered.has(`${entry.action}\0${entry.path}`)) {
      continue;
    }

    const parent = parentPath(entry.path);
    const key = `${entry.action}\0${parent}`;
    const group = smallGroups.get(key) || {
      action: entry.action,
      parent,
      order,
      entries: [],
    };
    group.entries.push(entry);
    smallGroups.set(key, group);
  }

  for (const group of smallGroups.values()) {
    if (group.parent !== "." && group.entries.length > 1) {
      entries.push(makeStagedGroupEntry(group.parent, group.entries, group.order));
      continue;
    }

    for (const entry of group.entries) {
      entries.push(makeStagedChangeEntry(entry, group.order));
      group.order += 0.001;
    }
  }

  return entries.sort((left, right) => left.order - right.order);
}

/**
 * Drive keeps empty folders, and a folder deleted locally after a sync emptied
 * it comes back as "new on Drive". Say how to delete it from Drive instead of
 * leaving the user to find out that pull would only recreate it.
 */
export function driveOnlyEmptyFolderHint(changes) {
  const count = changes.filter(
    (change) => change.changeType === "remote_added" && change.remoteMeta?.isFolder
  ).length;
  if (!count) return null;
  return (
    `  ${count === 1 ? "1 of these is an empty folder that exists" : `${count} of these are empty folders that exist`} only on Drive. ` +
    "'aethel pull' creates them locally; to delete them from Drive instead, " +
    "run 'aethel rm <path>' and then 'aethel push'."
  );
}
