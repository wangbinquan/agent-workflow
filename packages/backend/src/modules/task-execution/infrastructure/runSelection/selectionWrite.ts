import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { NodeRunFactSnapshot } from '../../application/ports/nodeRunQueries'
import type { RunSlot } from '../../application/ports/runSelection'
import { createRunSelectionReader } from './table/reader'
import { createRunSelectionParticipantInTx } from './table/selectionWrite'

/** The mint writer already holds the owner fence and task root. */
export async function selectMintedRunInTx(
  tx: PersistenceTx,
  run: {
    readonly id: string
    readonly taskId: string
    readonly slot: RunSlot
    readonly generationSeq: number
    readonly retryIndex: number
    readonly containerRunId: string | null
    readonly parentNodeRunId: string | null
    readonly shardKey: string | null
  },
  cause: string,
) {
  const reader = createRunSelectionReader(tx)
  if (run.slot.kind === 'synthetic' && run.slot.syntheticKind === 'repo-prep') {
    const incumbent = await reader.current(run.taskId, run.slot)
    if (incumbent && incumbent.retryIndex > run.retryIndex) return []
  }
  const expectedRevision = await reader.revision(run.taskId, run.slot)
  return createRunSelectionParticipantInTx().apply(tx, [
    {
      kind: 'select',
      taskId: run.taskId,
      slot: run.slot,
      run,
      expectedRevision,
      generationSeq: run.generationSeq,
      cause,
    },
  ])
}

/** Reopening changes status only; it never replaces a newer persisted selection. */
export async function reselectRunInTx(
  _tx: PersistenceTx,
  _run: NodeRunFactSnapshot,
  _cause: string,
) {
  return []
}
