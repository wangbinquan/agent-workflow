import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type {
  ConsumedInputsParticipantInTx,
  ConsumedInputsWrite,
} from '../application/ports/consumedInputs'
import {
  consumedEdgesFromRecord,
  decodeConsumedEdges,
  encodeConsumedEdges,
} from './runSelection/consumedCodec'
import { writeNodeRunTablesInTx, type RecordedNodeRunInput } from './nodeRunWriteProtocol'

/** Stable caller DTO; only the table participant persists it. */
export function prepareConsumedInputs(input: ConsumedInputsWrite): {
  consumedUpstreamRunsJson: string | null
} {
  return {
    consumedUpstreamRunsJson:
      'legacyJson' in input
        ? input.legacyJson
        : encodeConsumedEdges(
            'edges' in input ? input.edges : consumedEdgesFromRecord(input.record),
          ),
  }
}

/** Caller holds the task root (and the owner fence when owned) before any run CAS.
 * Explicit kinds allow aggregator shard facts without collapsing equal node IDs. */
export async function recordNodeRunInputsInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  inputs: readonly RecordedNodeRunInput[] | null,
): Promise<void> {
  await writeNodeRunTablesInTx(tx, nodeRunId, { inputs })
}

export function createConsumedInputsParticipantInTx(): ConsumedInputsParticipantInTx<PersistenceTx> {
  return {
    async record(tx, nodeRunId, input) {
      const json = prepareConsumedInputs(input).consumedUpstreamRunsJson
      await recordNodeRunInputsInTx(
        tx,
        nodeRunId,
        json === null
          ? null
          : decodeConsumedEdges(json).map((edge) => ({ ...edge, inputKind: 'frame-input' })),
      )
    },
  }
}
