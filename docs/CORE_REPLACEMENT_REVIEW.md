# Core Replacement Review

This review covers the current working tree, including the recent baseline and
logging changes. It identifies targeted replacements; it does not propose
replacing every core module. Two failures were reproduced using temporary local
workspaces. Other findings are based on the inspected control flow and require
regression tests before implementation.

## 1. Execution and recovery coordinator — highest priority

Implementation update: the focused coordinator replacement now checkpoints
partial successes, records durable completions, blocks failed-move dependents,
and locks commit execution. Recovery tests cover persistence boundaries and
cross-process exclusion. Ambiguous interrupted outcomes still require review;
identity planning and mutation preconditions remain separate follow-up work.
The evidence below describes the original failure that motivated this change.


Evidence: `src/core/sync.js:786` removes successful operations from staging,
while `src/core/repository.js:309` skips baseline saving when any operation fails.
Baseline persistence also occurs after staging is cleared on a fully successful
execution. A crash or persistence failure between those steps leaves the applied
operations without a committed baseline or durable completion record.

The reproduction staged a local deletion and an invalid operation. The deletion
succeeded, the invalid operation failed, and only the failed operation remained
staged. The snapshot still contained the deleted file's old remote binding.
Retrying from this state no longer has the successful deletion in the operation
list used to advance the baseline. The earlier baseline fix does not close this
partial-failure gap.

The executor also tracks failures by path and runs later operation groups after
rename failures. Dependent transfers are not explicitly blocked by a failed
parent move. No workspace-wide execution lock was found in the inspected flow.
Atomic replacement of individual JSON files does not serialize two sync runs.

Recommended replacement:

- A single coordinator shared by CLI and repository callers.
- A durable operation journal with stable operation IDs, expected source state,
  dependencies, execution results, and baseline-commit status.
- A workspace lock covering planning through baseline commit.
- Recovery that checks whether an operation already took effect before retrying.
- Baseline advancement from acknowledged results, with journal retirement only
  after baseline persistence succeeds.

Validation must cover mixed success/failure, parent-move failure, two processes
on one workspace, and process termination between each persistence boundary.
Diagnostic JSON-lines logs must remain separate from this recovery journal.

## 2. File identity and rename planning — high priority

Evidence: `src/core/diff.js:932` explicitly limits local folder matching to sibling
renames. Candidate filtering at line 975 rejects destinations under a different
parent. Nonempty folders are inferred from descendants because the remote sync
listing omits their explicit folder entries (`src/core/drive-api.js:829`).

This representation makes identity depend on path and content heuristics.
A move may still synchronize as deletion plus upload, but that does not preserve
identity or provide the same conflict semantics as an explicit move.

Recommended replacement: an identity resolver feeding a pure three-way planner.
Store all folder identities, parent relationships, and local identity hints.
Treat filesystem IDs as hints that require validation, not portable permanent
identities. Use content matching only when unambiguous. Keep identity matching,
content comparison, conflict decisions, and operation ordering separate.

Validation must cover moves between parents, nested moves, rename plus edit,
identical-content files, empty folders, and competing renames on two devices.

## 3. Local observation and hash caching — high priority, small scope

Evidence: `src/core/snapshot.js:347` reuses a hash when relative path, size, and
modification time match. The reproduction scanned `old`, replaced it with `new`,
and restored the original modification time. Both strings have the same length.
The second scan returned the old cached hash although hashing the file directly
returned a different value.

Recommended replacement: a small scanner/cache boundary that records file
identity and change metadata where supported, validates metadata before and
after hashing, and supports a verified scan that bypasses cached hashes.
Metadata shortcuts must be documented as heuristics; no metadata-only cache
can prove that content is unchanged in every filesystem environment.

Validation must cover preserved timestamps, replacement at the same path,
changes during scanning, coarse timestamp resolution, and cache corruption.
The existing snapshot serialization format need not be replaced for this work.

## 4. Destination validation and mutation preconditions — high priority

Evidence: `src/core/drive-api.js:814` projects Drive names directly into paths.
`downloadFile` at line 1215 replaces the destination after downloading without
revalidating whether the destination changed after planning. The staged model
contains hashes but has no uniform precondition policy for all mutations.

The current temporary-file download protects against interrupted transfers;
it does not protect a new local edit made during that transfer. No common
case-collision, Unicode-name, or platform-reserved-name policy was found in the
inspected planning and execution paths. These are review findings, not outcomes
verified on Windows or Linux during this review.

Recommended replacement: a shared path-mapping and mutation-validation layer.
Resolve destination collisions before execution; reject ambiguous mappings.
Check expected identity/content immediately before replacement or deletion,
preserve competing content, and replan when expectations fail. Rechecks reduce
race windows but must not be presented as atomic compare-and-swap guarantees.
Provider-specific conditional operations should only be used where their
semantics have been verified.

Validation must cover edits during download, case-only renames, colliding names,
export-extension collisions, reserved names, and changed deletion targets.

## 5. Drive inventory and transfer responsibilities — later extraction

`src/core/drive-api.js` currently combines inventory, shared memo management,
change-feed processing, retries, uploads/downloads, duplicate cleanup, and
interactive browsing. Splitting these responsibilities would make failures and
tests easier to isolate. Size alone is not evidence that every function needs
replacement.

Recommended extraction order: inventory/change-feed reader, transfer service,
and maintenance operations. Retain existing tested request helpers. Add
resumable transfer state and byte-level progress only after execution recovery
is established. Measure bytes retransferred, elapsed time, API calls, and peak
memory before choosing concurrency or transfer changes.

An existing compatibility exception also needs an explicit product decision:
`src/core/pack-sync.js:91` recreates a missing tracked archive, whereas ordinary
tracked uploads now stop when their remote ID disappears. Missing or inaccessible
archives should not implicitly be treated as authorized remote recreation in
unattended synchronization.

## Recommended sequence

Replace execution/recovery first. Harden the scanner independently because its
failure is reproduced and the change can remain small. Then replace identity
planning together with destination validation. Extract Drive services after
those contracts stabilize. Keep the new baseline updater and logging module,
adding regression coverage as the coordinator changes.
