import { and, eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import type { RunSelectionParticipantInTx } from '../../../application/ports/runSelection'
import { selectionRevision, validateSelectionChange } from '../../../domain/runSelection/changes'
import { encodeCanonicalRunSlot } from '../../../domain/runSelection/slotKey'

/** Revision zero denotes an absent slot. A clear retains its revision as a tombstone.
 * Caller fences owners, then locks every affected task root in task-id order before any write. */
export function createRunSelectionParticipantInTx(
  now: () => number = Date.now,
): RunSelectionParticipantInTx<PersistenceTx> {
  return {
    async apply(tx, changes) {
      for (const change of changes) validateSelectionChange(change)
      const {
        nodeRuns: runs,
        nodeRunSelections: selections,
        taskExecutionGenerations: generations,
      } = tablesOf(tx)
      for (const change of changes) {
        const [generation] = await tx
          .select({ seq: generations.generationSeq })
          .from(generations)
          .where(
            and(
              eq(generations.taskId, change.taskId),
              eq(generations.generationSeq, change.generationSeq),
            ),
          )
          .limit(1)
        if (!generation) throw new Error('selection-generation-missing')
      }
      const ids = changes.flatMap((change) => (change.kind === 'select' ? [change.run.id] : []))
      for (const id of [...new Set(ids)].sort())
        await engineOf(tx).lockAggregateRoot(tx, runs, runs.id, id)
      const revisions = []
      for (const change of changes) {
        const slotKey = encodeCanonicalRunSlot(change.slot)
        if (change.kind === 'select') {
          const [run] = await tx.select().from(runs).where(eq(runs.id, change.run.id)).limit(1)
          if (
            !run ||
            run.taskId !== change.taskId ||
            run.slotKey !== slotKey ||
            run.historicalParentId !== change.run.parentNodeRunId ||
            run.containerRunId !== change.run.containerRunId ||
            run.shardKey !== change.run.shardKey
          )
            throw new Error('selection-run-slot-mismatch')
          if (run.recordMode !== 'executable') throw new Error('selection-history-only')
        }
        const revision = selectionRevision(change)
        const values = {
          selectedRunId: change.kind === 'select' ? change.run.id : null,
          revision: revision.revision,
          generationSeq: change.generationSeq,
          cause: change.cause,
          selectedAt: now(),
        }
        const updated =
          change.expectedRevision === 0
            ? await tx
                .insert(selections)
                .values({ taskId: change.taskId, slotKey, ...values })
                .onConflictDoNothing()
                .returning({ revision: selections.revision })
            : await tx
                .update(selections)
                .set(values)
                .where(
                  and(
                    eq(selections.taskId, change.taskId),
                    eq(selections.slotKey, slotKey),
                    eq(selections.revision, change.expectedRevision),
                  ),
                )
                .returning({ revision: selections.revision })
        if (updated.length !== 1)
          throw new ConflictError(
            'selection-revision-conflict',
            `selection ${change.taskId}/${slotKey} changed concurrently`,
          )
        revisions.push(revision)
      }
      return revisions
    },
  }
}
