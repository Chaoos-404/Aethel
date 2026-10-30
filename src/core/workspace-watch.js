import fs from "node:fs";
import path from "node:path";
import { loadIgnoreRules } from "./ignore.js";

/** Stay well under typical inotify limits, which other programs share. */
export const MAX_WATCHED_DIRECTORIES = 400;

/**
 * Call `onChange` when something in the workspace may have changed.
 *
 * Watches directory by directory instead of using `recursive: true`: on Linux
 * that registers an inotify watch for every directory beneath the root,
 * including `node_modules` and anything in `.aethelignore`, and can use up the
 * limit that editors and other tools depend on. Ignored directories are never
 * entered, and watching stops at `maxDirectories`; a caller that also polls
 * loses nothing, so a partial watch is fine.
 *
 * @param {string} root
 * @param {() => void} onChange
 * @param {object} [options]
 * @param {number} [options.maxDirectories]
 * @returns {{ close(): void, readonly watched: number, readonly truncated: boolean }}
 */
export function watchWorkspace(
  root,
  onChange,
  { maxDirectories = MAX_WATCHED_DIRECTORIES } = {}
) {
  const rules = loadIgnoreRules(root);
  const watchers = new Map();
  let truncated = false;
  let closed = false;

  const relative = (absolute) => path.relative(root, absolute).split(path.sep).join("/");
  const ignored = (absolute, isDirectory) =>
    rules.ignores(isDirectory ? `${relative(absolute)}/` : relative(absolute));

  function unwatch(directory) {
    watchers.get(directory)?.close();
    watchers.delete(directory);
  }

  function watchTree(start) {
    const pending = [start];
    while (pending.length) {
      const directory = pending.pop();
      if (closed || watchers.has(directory)) continue;
      if (watchers.size >= maxDirectories) {
        truncated = true;
        return;
      }

      try {
        const watcher = fs.watch(directory, { persistent: false }, (_event, filename) =>
          handle(directory, filename)
        );
        // The directory went away or the system ran out of watches.
        watcher.on("error", () => unwatch(directory));
        watchers.set(directory, watcher);
      } catch {
        continue;
      }

      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        // Unreadable: it is still watched for what can be seen.
      }
      for (const entry of entries) {
        // Symlinked directories report isDirectory() false, so they are not followed.
        const child = path.join(directory, entry.name);
        if (entry.isDirectory() && !ignored(child, true)) pending.push(child);
      }
    }
  }

  function handle(directory, filename) {
    if (closed) return;
    if (filename) {
      const absolute = path.join(directory, String(filename));
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(absolute).isDirectory();
      } catch {
        // Already deleted or renamed away: still a change.
      }
      if (ignored(absolute, isDirectory)) return;
      // A directory created or moved in has no watcher yet.
      if (isDirectory) watchTree(absolute);
    }
    onChange();
  }

  watchTree(path.resolve(root));

  return {
    close() {
      closed = true;
      for (const directory of [...watchers.keys()]) unwatch(directory);
    },
    get watched() {
      return watchers.size;
    },
    get truncated() {
      return truncated;
    },
  };
}
