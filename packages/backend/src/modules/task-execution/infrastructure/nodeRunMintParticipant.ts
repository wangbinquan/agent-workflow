import { encodeSyntheticOwner } from '../domain/runSelection/syntheticOwner'
import { eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  driveAsyncProgram,
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import {
  buildNodeRunMintRecord,
  nodeRunLineageColumns,
} from '../application/buildNodeRunMintRecord'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import { childScopePath } from '../domain/environmentChain'
import { taskReadColumns } from './taskRepositorySql'
import { resolveTaskExecutionGenerationInTx } from './taskExecutionGeneration'
import { writeNodeRunTablesInTx } from './nodeRunWriteProtocol'
import { selectMintedRunInTx } from './runSelection/selectionWrite'

export interface NodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): Promise<string>
}

/** Identity, companions, recorded-empty inputs and selection commit with the allocation. */
export function* nodeRunMintProgram(
  tx: PersistenceTx,
  input: NodeRunMintInput,
): Generator<TransactionProgramStep, string, void> {
  const record = buildNodeRunMintRecord(input)
  const tables = tablesOf(tx)
  const generationSeq = yield* transactionStep(() =>
    resolveTaskExecutionGenerationInTx(tx, record.taskId, record.executionGeneration),
  )
  let scopePath = record.scopePath
  if (scopePath === null) {
    const container =
      record.containerRunId === null
        ? undefined
        : yield* transactionStep(() =>
            first(
              tx
                .select({ nodeId: tables.nodeRuns.nodeId, scopePath: tables.nodeRuns.scopePath })
                .from(tables.nodeRuns)
                .where(eq(tables.nodeRuns.id, record.containerRunId!)),
            ),
          )
    if (!container || container.scopePath === null) throw new Error('node-run-container-missing')
    scopePath = childScopePath(container.scopePath, container.nodeId, record.iteration)
  }
  const lineage = nodeRunLineageColumns(
    record,
    record.lineageSlotPathJson !== null
      ? undefined
      : yield* transactionStep(() =>
          first(
            tx
              .select({
                lineageSlotPathJson: taskReadColumns(tx).lineageSlotPathJson,
                workflowVersion: taskReadColumns(tx).workflowVersion,
              })
              .from(tables.tasks)
              .where(eq(tables.tasks.id, record.taskId)),
          ),
        ),
  )
  const allocation = yield* transactionStep(() =>
    first(
      tx
        .insert(tables.nodeRunSeqAllocations)
        .values({ taskId: record.taskId, nodeRunId: record.id, allocatedAt: Date.now() })
        .returning({ seq: tables.nodeRunSeqAllocations.seq }),
    ),
  )
  if (!allocation) throw new Error('node-run-seq-allocation-missing')
  const values = {
    id: record.id,
    taskId: record.taskId,
    nodeId: record.nodeId,
    role: record.role,
    slotKey: record.slotKey,
    syntheticOwner:
      record.role === 'synthetic'
        ? encodeSyntheticOwner(
            record.slot.kind === 'synthetic'
              ? record.slot.owner
              : { kind: 'task', id: record.taskId },
          )
        : null,
    generationSeq,
    seq: allocation.seq,
    attemptIndex: record.retryIndex,
    recordMode: 'executable' as const,
    provenanceQuality: 'recorded' as const,
    status: record.status,
    rerunCause: record.rerunCause,
    iteration: record.iteration,
    reviewIteration: record.reviewIteration,
    shardKey: record.shardKey,
    historicalParentId: record.parentNodeRunId,
    containerRunId: record.containerRunId,
    scopePath,
    envelopeNonce: record.envelopeNonce,
    wgRound: record.wgRound,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    errorMessage: record.errorMessage,
    forceActivated: record.forceActivated,
    operationGeneration: record.operationGeneration,
    ...lineage,
    inputsRecorded: record.recordedInputs !== null,
  }
  yield* transactionStep(() => insertOne(tx, tables.nodeRuns, values))
  yield* transactionStep(() =>
    writeNodeRunTablesInTx(tx, record.id, {
      config: {
        shardValueHash: record.shardValueHash,
        agentOverrideName: record.agentOverrideName,
        agentOverrideId: record.agentOverrideId,
      },
      checkpoint: { checkpoints: record.checkpoints },
      inputs: record.recordedInputs,
    }),
  )
  yield* transactionStep(() => selectMintedRunInTx(tx, { ...record, generationSeq }, input.cause))
  return record.id
}

export function createNodeRunMintParticipantInTx(tx: PersistenceTx): NodeRunMintParticipantInTx {
  return Object.freeze({
    mint: (input: NodeRunMintInput) =>
      driveAsyncProgram(nodeRunMintProgram(tx, input), (step) => step()),
  })
}
