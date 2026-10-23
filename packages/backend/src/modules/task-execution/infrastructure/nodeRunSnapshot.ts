import { MERGE_STATES, RerunCauseSchema, type MergeStateOrNull } from '@agent-workflow/shared'

import type { PersistenceTables } from '@/platform/persistence/sessionTables'
import type { NodeExecutionSnapshot } from '../application/ports/nodeExecutionPersistence'
import { deriveNodeRunRole } from '../domain/nodeRunRole'
import { decodeTaskCheckpoints, decodeTaskCheckpointInheritance } from './taskCheckpointCodec'

export function projectNodeRunSnapshot(
  row: PersistenceTables['nodeRuns']['$inferSelect'],
  mountPaths: readonly string[],
  hasContainerChildren = false,
): NodeExecutionSnapshot {
  if (row.mergeState !== null && !(MERGE_STATES as readonly string[]).includes(row.mergeState)) {
    throw new Error(`invalid persisted node merge state '${row.mergeState}'`)
  }
  return {
    ...projectNodeRunReadFacts(row, mountPaths, hasContainerChildren),
    rerunCause: row.rerunCause === null ? null : RerunCauseSchema.parse(row.rerunCause),
    mergeState: row.mergeState as MergeStateOrNull,
  }
}

/** 跨上下文旧读者允许历史 cause / merge-state 字符串；只投影，不改变其容错口径。 */
export function projectNodeRunReadFacts(
  row: PersistenceTables['nodeRuns']['$inferSelect'],
  mountPaths: readonly string[],
  hasContainerChildren = false,
): Omit<NodeExecutionSnapshot, 'rerunCause' | 'mergeState'> & {
  readonly rerunCause: string | null
  readonly mergeState: string | null
} {
  return {
    ...deriveNodeRunRole({ ...row, hasContainerChildren }),
    attemptIndex: row.retryIndex,
    seq: row.seq,
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    containerRunId: row.containerRunId,
    scopePath: row.scopePath,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    wgRound: row.wgRound,
    reviewIteration: row.reviewIteration,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    errorMessage: row.errorMessage,
    failureCode: row.failureCode,
    envelopeNonce: row.envelopeNonce,
    forceActivated: row.forceActivated,
    rerunCause: row.rerunCause,
    childTaskId: row.childTaskId,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
    promptText: row.promptText,
    promptPath: row.promptPath,
    runtime: row.runtime,
    runtimeBinary: row.runtimeBinary,
    runtimeParamsJson: row.runtimeParamsJson,
    inventorySnapshotJson: row.inventorySnapshotJson,
    runtimeInventoryJson: row.runtimeInventoryJson,
    injectedMemoriesJson: row.injectedMemoriesJson,
    agentOverrideName: row.agentOverrideName,
    agentOverrideId: row.agentOverrideId,
    shardValueHash: row.shardValueHash,
    pid: row.pid,
    spawnBinaryPath: row.spawnBinaryPath,
    spawnLaunchNonce: row.spawnLaunchNonce,
    opencodeSessionId: row.opencodeSessionId,
    startupVerificationJson: row.startupVerificationJson,
    wrapperProgressJson: row.wrapperProgressJson,
    isoWorktreePath: row.isoWorktreePath,
    mergeState: row.mergeState,
    tokInput: row.tokInput,
    tokOutput: row.tokOutput,
    tokCacheCreate: row.tokCacheCreate,
    tokCacheRead: row.tokCacheRead,
    tokTotal: row.tokTotal,
    portValidationFailuresJson: row.portValidationFailuresJson,
    commitPushJson: row.commitPushJson,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    checkpoints: decodeTaskCheckpoints(row, mountPaths),
    checkpointInheritance: decodeTaskCheckpointInheritance(row),
    consumedUpstreamRunsJson: row.consumedUpstreamRunsJson,
  }
}
