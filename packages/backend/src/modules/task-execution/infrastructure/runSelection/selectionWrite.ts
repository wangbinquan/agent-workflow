import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { NodeRunFactSnapshot } from '../../application/ports/nodeRunQueries'
import type { OracleRunRow } from './oracle/rows'
import { oracleRunSlot } from './oracle/rows'
import { createRunSelectionParticipantInTx } from './oracle/participant'

/** II-a 没有持久 revision/generation；0 仅是 oracle 的提案起点。 */
export async function selectMintedRunInTx(
  tx: PersistenceTx,
  run: Omit<
    OracleRunRow,
    'wrapperProgressJson' | 'childTaskId' | 'mergeState' | 'supersededByReview'
  >,
  cause: string,
) {
  const row: OracleRunRow = {
    wrapperProgressJson: null,
    childTaskId: null,
    mergeState: null,
    supersededByReview: null,
    ...run,
  }
  const slot = oracleRunSlot(row, [row])
  return createRunSelectionParticipantInTx<PersistenceTx>().apply(tx, [
    {
      kind: 'select',
      taskId: run.taskId,
      slot,
      run: { ...row, slot },
      expectedRevision: 0,
      generationSeq: 0,
      cause,
    },
  ])
}

/** Reopening only changes status. Mint order and therefore every current selection stay unchanged. */
export async function reselectRunInTx(
  tx: PersistenceTx,
  _run: NodeRunFactSnapshot,
  _cause: string,
) {
  return createRunSelectionParticipantInTx<PersistenceTx>().apply(tx, [])
}
