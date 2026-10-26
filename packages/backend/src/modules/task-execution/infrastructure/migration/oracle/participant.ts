import type { RunSelectionParticipantInTx } from '../../../application/ports/runSelection'
import { selectionRevision } from '../../../domain/runSelection/changes'

/** II-a 无表、无额外读写；回执是 proposed revision，持久 CAS 由 II-b 实现。 */
export function createRunSelectionParticipantInTx<Tx>(): RunSelectionParticipantInTx<Tx> {
  return {
    async apply(_tx, changes) {
      return changes.map(selectionRevision)
    },
  }
}
