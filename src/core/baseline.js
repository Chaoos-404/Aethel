/**
 * Paths covered by Drive: every remote path plus each of its ancestors.
 *
 * Build once instead of scanning the whole remote list per local file.
 */
export function buildRemoteCoverage(remoteFiles) {
  const covered = new Set();

  for (const file of remoteFiles || []) {
    const pathValue = file?.path;
    if (!pathValue) continue;

    covered.add(pathValue);
    const parts = pathValue.split("/");
    while (parts.length > 1) {
      parts.pop();
      covered.add(parts.join("/"));
    }
  }

  return covered;
}

/**
 * Advance only executed operations. A fresh Drive inventory is an observation,
 * not evidence that the device applied every change represented by it.
 */
export function advanceBaseline(previous, remoteFiles, scannedLocal, appliedChanges) {
  const remote = new Map(
    Object.entries(previous?.files || {}).map(([id, entry]) => [id, { ...entry, id }])
  );
  const local = { ...(previous?.localFiles || {}) };
  const currentLocal = scannedLocal?.files ?? scannedLocal ?? {};
  const currentById = new Map(remoteFiles.map(entry => [entry.id, entry]));
  const currentByPath = new Map(remoteFiles.map(entry => [entry.path, entry]));
  const under = (candidate, parent) =>
    typeof candidate === "string" && typeof parent === "string" &&
    (candidate === parent || candidate.startsWith(`${parent}/`));
  const action = change => change.action || change.suggestedAction;
  const moves = appliedChanges.filter(change => ["move_local", "rename_remote"].includes(action(change)) && change.sourcePath)
    .sort((a, b) => b.sourcePath.split("/").length - a.sourcePath.split("/").length);
  const remap = pathValue => {
    for (const change of moves) if (pathValue && under(pathValue, change.sourcePath)) pathValue = `${change.path}${pathValue.slice(change.sourcePath.length)}`;
    return pathValue;
  };
  // A metadata move acknowledges location only. It cannot acknowledge an
  // unrelated content edit anywhere inside the relocated subtree.
  for (const [id, entry] of remote) {
    const oldPath = entry.path || entry.localPath;
    const nextPath = remap(oldPath);
    if (nextPath !== oldPath) {
      remote.set(id, {
        ...entry,
        path: nextPath,
        localPath: nextPath,
        name: nextPath.split("/").at(-1),
      });
    }
  }
  const carriedLocal = {};
  for (const [pathValue, entry] of Object.entries(local)) {
    const nextPath = remap(pathValue);
    carriedLocal[nextPath] = nextPath === pathValue ? entry : { ...entry, localPath: nextPath };
  }
  function remove(pathValue, fileId) {
    for (const [id, entry] of remote) {
      if (id === fileId || under(entry.path || entry.localPath, pathValue)) remote.delete(id);
    }
    for (const key of Object.keys(carriedLocal)) if (under(key, pathValue)) delete carriedLocal[key];
  }
  // The executor applies deletions before transfers regardless of staging
  // order. Remove old bindings before adopting a relocated file with that ID.
  const orderedChanges = [...appliedChanges].sort((left, right) =>
    Number(action(right).startsWith("delete_")) - Number(action(left).startsWith("delete_"))
  );
  for (const change of orderedChanges) {
    const kind = action(change);
    const localPath = remap(change.localPath || change.path);
    const remotePath = remap(change.remotePath || change.remoteMeta?.path || change.path);
    if (kind === "delete_local") {
      if (!Object.keys(currentLocal).some(pathValue => under(pathValue, localPath))) remove(localPath, change.fileId);
      continue;
    }
    if (kind === "delete_remote") {
      const stillRemote = change.fileId
        ? currentById.has(change.fileId)
        : remoteFiles.some(entry => under(entry.path, remotePath));
      if (!stillRemote) remove(remotePath, change.fileId);
      continue;
    }
    if (!["upload", "download", "move_local", "rename_remote"].includes(kind)) continue;
    const remoteEntry = currentById.get(change.fileId) || currentByPath.get(remotePath);
    const localEntry = currentLocal[localPath];
    if (!remoteEntry || !localEntry) continue;
    const folder = Boolean(remoteEntry.isFolder) && Boolean(localEntry.isFolder);
    if (!folder && (!remoteEntry.md5Checksum || remoteEntry.md5Checksum !== localEntry.md5)) continue;
    // A confirmed same-path ID replacement supersedes the previous binding.
    for (const [id, old] of remote) {
      if (id !== remoteEntry.id && (old.path || old.localPath) === remoteEntry.path) remote.delete(id);
    }
    remote.set(remoteEntry.id, { ...remoteEntry, localPath });
    carriedLocal[localPath] = localEntry;
  }
  // A move or deletion can leave the old parent directories empty, and the
  // executor prunes the ones Drive no longer has. Their folder entries were
  // recorded as empty folders in the baseline; keeping an entry for a folder
  // that is gone from both sides would later read as a local deletion of
  // whatever Drive next puts at that path.
  for (const change of appliedChanges) {
    const kind = action(change);
    if (kind !== "move_local" && kind !== "delete_local") continue;
    const origin = kind === "move_local" ? change.sourcePath : change.localPath || change.path;
    if (typeof origin !== "string") continue;
    for (let slash = origin.lastIndexOf("/"); slash > 0; slash = origin.lastIndexOf("/", slash - 1)) {
      const ancestor = origin.slice(0, slash);
      if (!carriedLocal[ancestor]?.isFolder) continue;
      if (Object.keys(currentLocal).some(pathValue => under(pathValue, ancestor))) continue;
      delete carriedLocal[ancestor];
    }
  }
  // The opposite case: a deletion or move can empty a folder that survives on
  // both sides, because Drive keeps empty folders and the executor prunes only
  // the ones Drive lost. Until now the baseline knew such a folder only through
  // the files it held, so once they were gone it knew nothing of it. When the
  // folder is later deleted locally, Drive's listing now carries it as an
  // explicit empty folder with no baseline entry to be a deletion of, and it
  // reads as new on Drive — a deletion that can never be pushed. Record every
  // vacated ancestor that disk and Drive both hold as an empty folder, exactly
  // as an initial sync would have recorded it.
  const coveredByRemote = buildRemoteCoverage(remoteFiles);
  for (const change of appliedChanges) {
    const kind = action(change);
    let origin = null;
    if (kind === "move_local" || kind === "rename_remote") origin = change.sourcePath;
    else if (kind === "delete_local" || kind === "delete_remote") origin = remap(change.localPath || change.path);
    if (typeof origin !== "string") continue;
    for (let slash = origin.lastIndexOf("/"); slash > 0; slash = origin.lastIndexOf("/", slash - 1)) {
      const ancestor = origin.slice(0, slash);
      const scanned = currentLocal[ancestor];
      if (!scanned?.isFolder || !coveredByRemote.has(ancestor)) continue;
      carriedLocal[ancestor] = scanned;
      // Drive lists only the leaf of an empty branch; its parents are implied.
      const listed = currentByPath.get(ancestor);
      if (!listed?.isFolder) continue;
      for (const [id, old] of remote) {
        if (id !== listed.id && (old.path || old.localPath) === listed.path) remote.delete(id);
      }
      remote.set(listed.id, { ...listed, localPath: ancestor });
    }
  }
  return {
    remote: [...remote.values()],
    local: { files: carriedLocal, packedDirs: scannedLocal?.packedDirs || {} },
  };
}
