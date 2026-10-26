import { MERGE_STATES, RerunCauseSchema, type MergeStateOrNull } from '@agent-workflow/shared'
import { and, asc, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import type { NodeExecutionSnapshot } from '../application/ports/nodeExecutionPersistence'
import type { TaskRepositoryCheckpoint } from '../domain/taskCheckpoint'
import { decodeCanonicalRunSlot } from '../domain/runSelection/slotKey'

type Row<K extends keyof PersistenceTables> = PersistenceTables[K] extends {
  $inferSelect: infer R
}
  ? R
  : never
export interface NodeRunSnapshotRows {
  readonly run: Row<'nodeRuns'>
  readonly config: Row<'nodeRunConfigs'> | null
  readonly runtime: Row<'nodeRunRuntimeStates'> | null
  readonly result: Row<'nodeRunResults'> | null
  readonly checkpoints: readonly TaskRepositoryCheckpoint[]
  readonly inputs: readonly { readonly producerNodeId: string; readonly producerRunId: string }[]
}

export async function readNodeRunSnapshotRows(
  db: PersistenceDb,
  nodeRunId: string,
): Promise<NodeRunSnapshotRows | null> {
  const {
    nodeRuns: run,
    nodeRunConfigs: config,
    nodeRunRuntimeStates: runtime,
    nodeRunResults: result,
    nodeRunRepoCheckpoints: checkpoint,
    taskRepositoryMounts: mounts,
    nodeRunInputs: inputs,
  } = tablesOf(db)
  const [row] = await db
    .select({ run, config, runtime, result })
    .from(run)
    .leftJoin(config, eq(config.nodeRunId, run.id))
    .leftJoin(runtime, eq(runtime.nodeRunId, run.id))
    .leftJoin(result, eq(result.nodeRunId, run.id))
    .where(eq(run.id, nodeRunId))
    .limit(1)
  if (!row) return null
  const stored = await db
    .select({
      mountPath: mounts.mountPath,
      preSnapshot: checkpoint.preSnapshot,
      isolationBase: checkpoint.isolationBase,
      nodeTree: checkpoint.nodeTree,
      submodules: checkpoint.submodules,
    })
    .from(checkpoint)
    .innerJoin(
      mounts,
      and(eq(mounts.taskId, checkpoint.taskId), eq(mounts.repoKey, checkpoint.repoKey)),
    )
    .where(eq(checkpoint.nodeRunId, nodeRunId))
    .orderBy(asc(mounts.ordinal))
  return {
    ...row,
    checkpoints: stored.map((value) => ({
      mountPath: value.mountPath,
      ...(value.preSnapshot === null ? {} : { preSnapshot: value.preSnapshot }),
      ...(value.isolationBase === null ? {} : { isolationBase: value.isolationBase }),
      ...(value.nodeTree === null ? {} : { nodeTree: value.nodeTree }),
      ...(value.submodules === null
        ? {}
        : { submodules: JSON.parse(value.submodules) as TaskRepositoryCheckpoint['submodules'] }),
    })),
    inputs: await db
      .select({ producerNodeId: inputs.producerNodeId, producerRunId: inputs.producerRunId })
      .from(inputs)
      .where(and(eq(inputs.consumerRunId, nodeRunId), eq(inputs.inputKind, 'frame-input')))
      .orderBy(asc(inputs.ordinal)),
  }
}

export function projectNodeRunHistoryFacts(
  rows: NodeRunSnapshotRows,
  promptText: string | null = null,
) {
  const { run: row, config, runtime, result } = rows
  const slot = row.slotKey === null ? null : decodeCanonicalRunSlot(row.slotKey)
  const prompt = contentRefColumns.decode(
    config?.promptRefJson ?? null,
    config?.promptInlineBytes ?? null,
  )
  const legacyPromptLocation =
    prompt?.kind === 'local-file' &&
    prompt.location.codec === 'prompt' &&
    typeof prompt.location.value === 'object' &&
    prompt.location.value !== null &&
    'promptPath' in prompt.location.value
      ? prompt.location.value
      : null
  return {
    identity:
      row.role === null || slot === null || row.attemptIndex === null || row.scopePath === null
        ? ('unknown' as const)
        : ('known' as const),
    recordMode: row.recordMode,
    slot,
    generationSeq: row.generationSeq,
    role: row.role,
    syntheticKind:
      slot?.kind === 'synthetic'
        ? slot.syntheticKind
        : slot?.kind === 'workgroup-host'
          ? ('workgroup-host' as const)
          : null,
    attemptIndex: row.attemptIndex,
    retryIndex: row.attemptIndex,
    seq: row.seq,
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.historicalParentId,
    containerRunId: row.containerRunId,
    scopePath: row.scopePath,
    iteration: row.iteration,
    shardKey: row.shardKey,
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
    promptText:
      prompt?.kind === 'inline'
        ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(prompt.bytes)
        : promptText,
    promptPath:
      typeof legacyPromptLocation?.promptPath === 'string' ? legacyPromptLocation.promptPath : null,
    runtime: config?.runtime ?? null,
    runtimeBinary: config?.runtimeBinary ?? null,
    runtimeParamsJson: config?.runtimeParamsJson ?? null,
    inventorySnapshotJson: config?.inventorySnapshotJson ?? null,
    runtimeInventoryJson: config?.runtimeInventoryJson ?? null,
    injectedMemoriesJson: config?.injectedMemoriesJson ?? null,
    agentOverrideName: config?.agentOverrideName ?? null,
    agentOverrideId: config?.agentOverrideId ?? null,
    shardValueHash: config?.shardValueHash ?? null,
    pid: runtime?.pid ?? null,
    spawnBinaryPath: runtime?.spawnBinaryPath ?? null,
    spawnLaunchNonce: runtime?.spawnLaunchNonce ?? null,
    opencodeSessionId: runtime?.sessionId ?? null,
    startupVerificationJson: runtime?.startupVerificationJson ?? null,
    wrapperProgressJson: runtime?.wrapperProgressJson ?? null,
    isoWorktreePath: runtime?.isolationRootRef ?? null,
    mergeState: runtime?.mergeState ?? null,
    tokInput: result?.tokInput ?? null,
    tokOutput: result?.tokOutput ?? null,
    tokCacheCreate: result?.tokCacheCreate ?? null,
    tokCacheRead: result?.tokCacheRead ?? null,
    tokTotal: result?.tokTotal ?? null,
    portValidationFailuresJson: result?.portValidationFailuresJson ?? null,
    commitPushJson: result?.commitPushJson ?? null,
    supersededByReview: result?.supersededByReview ?? null,
    rolledBack: result?.rolledBack ?? null,
    checkpoints: rows.checkpoints,
    checkpointInheritance: rows.checkpoints.flatMap(({ mountPath, preSnapshot }) =>
      preSnapshot === undefined ? [] : [{ mountPath, preSnapshot }],
    ),
    consumedUpstreamRunsJson: row.inputsRecorded
      ? JSON.stringify(
          Object.fromEntries(rows.inputs.map((edge) => [edge.producerNodeId, edge.producerRunId])),
        )
      : null,
  }
}

export function projectNodeRunReadFacts(
  rows: NodeRunSnapshotRows,
  promptText: string | null = null,
): Omit<NodeExecutionSnapshot, 'rerunCause' | 'mergeState'> & {
  readonly rerunCause: string | null
  readonly mergeState: string | null
} {
  const facts = projectNodeRunHistoryFacts(rows, promptText)
  if (
    facts.role === null ||
    facts.slot === null ||
    facts.scopePath === null ||
    facts.retryIndex === null
  )
    throw new Error(`node-run-history-identity-unresolved:${facts.id}`)
  return {
    ...facts,
    role: facts.role,
    slot: facts.slot,
    scopePath: facts.scopePath,
    retryIndex: facts.retryIndex,
    attemptIndex: facts.retryIndex,
  }
}

export function projectNodeRunSnapshot(
  rows: NodeRunSnapshotRows,
  promptText: string | null = null,
): NodeExecutionSnapshot {
  const facts = projectNodeRunReadFacts(rows, promptText)
  if (facts.mergeState !== null && !(MERGE_STATES as readonly string[]).includes(facts.mergeState))
    throw new Error(`invalid persisted node merge state '${facts.mergeState}'`)
  return {
    ...facts,
    rerunCause: facts.rerunCause === null ? null : RerunCauseSchema.parse(facts.rerunCause),
    mergeState: facts.mergeState as MergeStateOrNull,
  }
}

export async function readNodeRunSnapshot(
  db: PersistenceDb,
  nodeRunId: string,
  content: Pick<ContentStore, 'read'>,
): Promise<NodeExecutionSnapshot | null> {
  const rows = await readNodeRunSnapshotRows(db, nodeRunId)
  if (!rows) return null
  const prompt = contentRefColumns.decode(
    rows.config?.promptRefJson ?? null,
    rows.config?.promptInlineBytes ?? null,
  )
  // Converted prompt paths retain the epoch-1 lazy reader and its unreadable-file fallback.
  const text =
    prompt &&
    prompt.kind !== 'inline' &&
    !(prompt.kind === 'local-file' && prompt.location.codec === 'prompt')
      ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await content.read(prompt))
      : null
  return projectNodeRunSnapshot(rows, text)
}
