// RFC-395 II-a A3：消费写入复用调用方事务；CAS 伴随项通过 columns 并入同一句 UPDATE。
import { eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type {
  ConsumedInputsParticipantInTx,
  ConsumedInputsWrite,
} from '../application/ports/consumedInputs'
import { consumedEdgesFromRecord, encodeConsumedEdges } from './runSelection/consumedCodec'

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

/** Mint / lifecycle / projection 的伴随写不能拆出第二条 SQL。 */
export function consumedInputColumns(
  input: { readonly consumedUpstreamRunsJson?: string | null } | undefined,
): { consumedUpstreamRunsJson?: string | null } {
  return input?.consumedUpstreamRunsJson === undefined
    ? {}
    : prepareConsumedInputs({ legacyJson: input.consumedUpstreamRunsJson })
}

export function createConsumedInputsParticipantInTx(): ConsumedInputsParticipantInTx<PersistenceTx> {
  return {
    async record(tx, nodeRunId, input) {
      const { nodeRuns } = tablesOf(tx)
      await tx.update(nodeRuns).set(prepareConsumedInputs(input)).where(eq(nodeRuns.id, nodeRunId))
    },
  }
}
