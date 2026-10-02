import { readIndex, readLatestSnapshot, writeIndex } from "./config.js";
import { openExecutionJournal, operationKey } from "./execution-journal.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { logEvent } from "./logger.js";

/** Save completed effects before retiring either their staging or receipts. */
export async function commitWorkspace(repo, { message = "sync", progress } = {}) {
  return withWorkspaceLock(repo.root, async () => {
    async function checkpoint() {
      const journal = openExecutionJournal(repo.root);
      const completed = journal.completed();
      if (!completed.length) return false;
      const recorded = new Set(readLatestSnapshot(repo.root)?.executionReceipts || []);
      const unapplied = completed.filter(op => !recorded.has(op.id));
      if (unapplied.length) {
        // A recovery scan must be fresh on both sides, even when the original
        // caller supplied pre-transfer hints.
        await repo.saveSnapshot(message, {
          appliedChanges: unapplied.map(op => op.entry),
          executionReceipts: completed.map(op => op.id),
        });
      } else {
        // Snapshot persistence can succeed before updating the current ref.
        repo.updateCurrentBranch(readLatestSnapshot(repo.root));
      }
      const keys = new Set(completed.map(op => operationKey(op.original)));
      const index = readIndex(repo.root);
      index.staged = (index.staged || []).filter(entry => !keys.has(operationKey(entry)));
      writeIndex(repo.root, index);
      journal.acknowledge(completed.map(op => op.id));
      logEvent("info", "execution.checkpointed", { operations: completed.length });
      return true;
    }
    const recovered = await checkpoint();
    openExecutionJournal(repo.root).assertRecoverable();
    const result = await repo.executeStaged(progress);
    result.baselineSaved = await checkpoint() || recovered;
    openExecutionJournal(repo.root).acknowledge([]);
    return result;
  });
}
