// RFC-374: complete sequence catch-up before any boot recovery can select a run.
import type {
  NodeRunSeqBackfillReport,
  NodeRunSeqBackfillStore,
} from './ports/nodeRunSeqBackfillStore'

export async function backfillNodeRunSequences(
  store: NodeRunSeqBackfillStore,
): Promise<NodeRunSeqBackfillReport> {
  let tasks = 0
  let runs = 0
  for (;;) {
    const ids = await store.listTaskIds(100)
    if (ids.length === 0) break
    let batchRuns = 0
    for (const id of ids) {
      batchRuns += await store.backfillTask(id)
      tasks++
    }
    // Boot is the only writer here, so a listed task always has a NULL row to fill;
    // a batch that fills nothing would list the same tasks forever.
    if (batchRuns === 0) throw new Error('node-run-seq-backfill-stalled')
    runs += batchRuns
  }
  await store.assertAllocatorCurrent()
  let allocationsPruned = 0
  for (;;) {
    const deleted = await store.pruneAllocations()
    allocationsPruned += deleted
    if (deleted === 0) break
  }
  return { tasks, runs, allocationsPruned }
}
