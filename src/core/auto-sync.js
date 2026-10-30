/**
 * Automatic two-way sync, as used by the TUI sync panel.
 *
 * One cycle is `status` → `add` → `commit` with the conflicts left out:
 * everything that changed on only one side is applied in both directions,
 * and anything that changed on both sides is returned for a human to decide.
 * Conflicts are never resolved here.
 */

import { ChangeType } from "./diff.js";

/** Panel choice → strategy understood by Repository.stageConflictResolution(). */
const STRATEGY = Object.freeze({ local: "ours", remote: "theirs", both: "both" });

export const CONFLICT_CHOICES = Object.freeze(Object.keys(STRATEGY));

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Sort a diff into what a cycle may apply and what needs a person.
 *
 * Changes underneath a conflicted path (or moving one) are held back with it:
 * applying a child of a conflicted folder first would decide the conflict by
 * accident. A conflict already staged by `resolve` is on its way out, so it is
 * counted as `resolving` instead of being asked about again.
 *
 * @param {object} diff          Result of computeDiff()
 * @param {Set<string>} stagedPaths  Paths currently in the staging area
 */
export function planSync(diff, stagedPaths = new Set()) {
  const conflicts = [];
  const resolving = [];
  for (const conflict of diff.conflicts) {
    (stagedPaths.has(conflict.path) ? resolving : conflicts).push(conflict);
  }

  const blockedBy = [...conflicts, ...resolving].map((conflict) => conflict.path);
  const isBlocked = (change) =>
    blockedBy.some(
      (blocked) =>
        overlaps(change.path, blocked) ||
        (change.sourcePath && overlaps(change.sourcePath, blocked))
    );

  const pull = [];
  const push = [];
  const held = [];
  for (const change of diff.changes) {
    if (change.changeType === ChangeType.CONFLICT) continue;
    if (isBlocked(change)) {
      held.push(change);
    } else if (change.changeType.startsWith("remote")) {
      pull.push(change);
    } else if (change.changeType.startsWith("local")) {
      push.push(change);
    }
  }

  return {
    pull,
    push,
    held,
    conflicts,
    resolving,
    packConflicts: diff.packConflicts ?? [],
  };
}

/**
 * Which choices make sense for a conflict. "Keep remote" and "keep both" both
 * download the Drive copy, so they need a Drive copy to exist; "keep both"
 * also needs a local file to keep.
 */
export function conflictChoices(conflict) {
  const choices = ["local"];
  if (conflict.remoteMeta) choices.push("remote");
  if (conflict.remoteMeta && conflict.localMeta) choices.push("both");
  return choices;
}

/** One side of a conflict as the panel shows it. */
export function describeSide(meta, { md5Key }) {
  if (!meta) return { present: false };
  const size = meta.size == null ? NaN : Number(meta.size);
  return {
    present: true,
    size: Number.isFinite(size) ? size : null,
    modifiedTime: meta.modifiedTime || null,
    md5: meta[md5Key] || null,
    isFolder: Boolean(meta.isFolder),
  };
}

/** A conflict reduced to what the resolve panel needs. */
export function describeConflict(conflict) {
  const local = describeSide(conflict.localMeta, { md5Key: "md5" });
  const remote = describeSide(conflict.remoteMeta, { md5Key: "md5Checksum" });
  let kind = "both sides changed";
  if (!local.present) kind = "deleted locally, changed on Drive";
  else if (!remote.present) kind = "changed locally, deleted on Drive";
  return { path: conflict.path, kind, local, remote, choices: conflictChoices(conflict) };
}

/**
 * Stage a conflict resolution. Applying it is left to the next cycle (or
 * `commit`), so a resolution is recoverable until then with `reset`.
 *
 * @param {"local"|"remote"|"both"} choice
 */
export function resolveConflict(repo, conflict, choice) {
  const strategy = STRATEGY[choice];
  if (!strategy) {
    throw new Error(`Unknown conflict choice '${choice}'. Use local, remote, or both.`);
  }
  if (!conflictChoices(conflict).includes(choice)) {
    throw new Error(`Cannot keep '${choice}' for ${conflict.path}: that side does not exist.`);
  }
  repo.stageConflictResolution(conflict, strategy);
}

/**
 * Run one sync cycle against a workspace repository.
 *
 * Without a baseline snapshot there is nothing to tell a deletion from an
 * addition, so the first sync is left to `pull --all` / `commit`: guessing
 * could wipe either side.
 *
 * @param {import("./repository.js").Repository} repo
 * @param {object} [options]
 * @param {string} [options.message]   Snapshot message
 * @param {(phase: "scan"|"apply") => void} [options.onPhase]
 * @param {(done: number, total: number, verb: string, name: string) => void} [options.progress]
 */
export async function runSyncCycle(repo, { message = "auto-sync", onPhase, progress } = {}) {
  const outcome = {
    skipped: null,
    pulled: 0,
    pushed: 0,
    held: 0,
    conflicts: [],
    resolving: 0,
    packConflicts: 0,
    errors: [],
    summary: "",
    baselineSaved: false,
  };

  if (!repo.getSnapshot()) {
    outcome.skipped = "no-baseline";
    return outcome;
  }

  onPhase?.("scan");
  const { diff } = await repo.loadState({ useCache: false });
  const plan = planSync(
    diff,
    new Set(repo.getStagedEntries().map((entry) => entry.path))
  );

  outcome.conflicts = plan.conflicts;
  outcome.resolving = plan.resolving.length;
  outcome.held = plan.held.length;
  outcome.packConflicts = plan.packConflicts.length;

  const toStage = [...plan.pull, ...plan.push];
  if (toStage.length) repo.stageChanges(toStage);

  // Also covers entries left staged by an earlier failed cycle or by `resolve`.
  if (repo.getStagedEntries().length === 0) return outcome;

  onPhase?.("apply");
  const result = await repo.commitStaged({ message, progress });
  outcome.pulled = plan.pull.length;
  outcome.pushed = plan.push.length;
  outcome.errors = result.errors;
  outcome.summary = result.summary;
  outcome.baselineSaved = Boolean(result.baselineSaved);
  return outcome;
}
