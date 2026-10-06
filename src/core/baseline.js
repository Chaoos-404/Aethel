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
  return {
    remote: [...remote.values()],
    local: { files: carriedLocal, packedDirs: scannedLocal?.packedDirs || {} },
  };
}
