import type { RecordedNodeRunInput } from '../domain/consumedInputs'
import { and, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm'
import type { MergeStateOrNull } from '@agent-workflow/shared'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { contentRefColumns } from '@/platform/content/contentStore'
import type { ContentRef } from '@/platform/content/contentRef'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { TaskMountKey } from '../application/ports/taskMountKeys'
import type {
  NodeRunCheckpointWrite,
  NodeRunLifecycleWrite,
  NodeRunProjectionWrite,
} from '../application/ports/nodeRunWrites'
import { nodeRunRowPresence } from '../domain/nodeRunRowPresence'
import { producerShardSlot } from '../domain/runInputShard'
import { taskAggregateWrite } from './taskDefinitionWriteParticipant'
import { taskMountKeysReader } from './taskCheckpointPersistence'
import { decodeConsumedEdges } from './runSelection/consumedCodec'

type Run = PersistenceTables['nodeRuns']['$inferSelect']
type Config = Omit<PersistenceTables['nodeRunConfigs']['$inferInsert'], 'nodeRunId'>
type Runtime = Omit<
  PersistenceTables['nodeRunRuntimeStates']['$inferInsert'],
  'nodeRunId' | 'mergeState'
>
type Result = Omit<PersistenceTables['nodeRunResults']['$inferInsert'], 'nodeRunId'>
export type NodeRunIdentityPatch = Partial<
  Pick<
    Run,
    | 'status'
    | 'reviewIteration'
    | 'startedAt'
    | 'finishedAt'
    | 'exitCode'
    | 'errorMessage'
    | 'failureCode'
    | 'childTaskId'
  >
>
export type { RecordedNodeRunInput } from '../domain/consumedInputs'
export interface NodeRunTableWrite {
  readonly config?: Config
  readonly runtime?: Runtime
  readonly result?: Result
  readonly checkpoint?: NodeRunCheckpointWrite
  readonly inputs?: readonly RecordedNodeRunInput[] | null
}

/** Call after the owner fence, before subordinate/run writes. The read only locates the root. */
export async function lockNodeRunTaskRootInTx(
  tx: PersistenceTx,
  nodeRunId: string,
): Promise<string> {
  const { nodeRuns } = tablesOf(tx)
  const [run] = await tx
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  if (!run) throw new NotFoundError('node-run-not-found', `node_run ${nodeRunId} not found`)
  await taskAggregateWrite.lockTaskAggregateRoot(tx, run.taskId)
  return run.taskId
}

async function lockRun(
  tx: PersistenceTx,
  nodeRunId: string,
  requireExecutable = true,
): Promise<Run> {
  const { nodeRuns } = tablesOf(tx)
  await engineOf(tx).lockAggregateRoot(tx, nodeRuns, nodeRuns.id, nodeRunId)
  const [run] = await tx.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
  if (!run) throw new NotFoundError('node-run-not-found', `node_run ${nodeRunId} not found`)
  if (requireExecutable && run.recordMode !== 'executable') throw new Error('node-run-history-only')
  return run
}

async function writeCheckpoints(
  tx: PersistenceTx,
  run: Run,
  write: NodeRunCheckpointWrite,
  mounts: readonly TaskMountKey[],
) {
  const { nodeRunRepoCheckpoints: checkpoints } = tablesOf(tx)
  const byPath = new Map(mounts.map((mount) => [mount.mountPath, mount]))
  for (const value of [...(write.checkpoints ?? []), ...(write.pendingSubResolves ?? [])])
    if (!byPath.has(value.mountPath))
      throw new Error(`node-run-checkpoint-mount-missing:${value.mountPath}`)
  for (const path of write.checkpointMountPaths ?? [])
    if (!byPath.has(path)) throw new Error(`node-run-checkpoint-mount-missing:${path}`)
  const fields = ['preSnapshot', 'isolationBase', 'nodeTree', 'submodules'] as const
  const touched =
    write.checkpointComponents ??
    (write.checkpoints?.length === 0
      ? fields
      : fields.filter((field) => write.checkpoints?.some((value) => Object.hasOwn(value, field))))
  const scope =
    write.checkpointMountPaths === undefined
      ? mounts
      : mounts.filter((mount) => write.checkpointMountPaths!.includes(mount.mountPath))
  for (const mount of scope) {
    const value = write.checkpoints?.find((entry) => entry.mountPath === mount.mountPath)
    const pending = write.pendingSubResolves?.find((entry) => entry.mountPath === mount.mountPath)
    if (touched.length === 0 && !pending) continue
    const key = and(eq(checkpoints.nodeRunId, run.id), eq(checkpoints.repoKey, mount.repoKey))
    const [previous] = await tx.select().from(checkpoints).where(key).limit(1)
    const patch: Partial<Pick<typeof checkpoints.$inferInsert, (typeof fields)[number]>> = {}
    for (const field of touched) {
      if (field === 'submodules')
        patch.submodules = value?.submodules === undefined ? null : JSON.stringify(value.submodules)
      else patch[field] = value?.[field] ?? null
    }
    if (pending) {
      const raw = patch.submodules === undefined ? previous?.submodules : patch.submodules
      let base: object = { poolDirs: pending.poolDirs, subBases: pending.subBases }
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') base = parsed
        } catch {
          /* Live topology supplies the replacement for an unreadable old value. */
        }
      }
      patch.submodules = JSON.stringify({ ...base, pendingSubResolves: pending.pendingSubResolves })
    }
    if (previous) await tx.update(checkpoints).set(patch).where(key)
    else if (Object.values(patch).some((value) => value !== null))
      await insertOne(tx, checkpoints, {
        nodeRunId: run.id,
        taskId: run.taskId,
        repoKey: mount.repoKey,
        ...patch,
      })
  }
}

async function replaceInputs(
  tx: PersistenceTx,
  run: Run,
  inputs: readonly RecordedNodeRunInput[] | null,
) {
  const { nodeRuns, nodeRunInputs } = tablesOf(tx)
  const rows: (typeof nodeRunInputs.$inferInsert)[] = []
  const keys = new Set<string>()
  for (const [ordinal, input] of (inputs ?? []).entries()) {
    const [producer] = await tx
      .select({ taskId: nodeRuns.taskId, nodeId: nodeRuns.nodeId, shardKey: nodeRuns.shardKey })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.producerRunId))
      .limit(1)
    if (!producer || producer.taskId !== run.taskId || producer.nodeId !== input.producerNodeId)
      throw new Error('node-run-input-producer-mismatch')
    const shardKey =
      input.producerShardKey === undefined ? producer.shardKey : input.producerShardKey
    if (shardKey !== producer.shardKey) throw new Error('node-run-input-shard-mismatch')
    const shard = producerShardSlot(shardKey)
    const key = JSON.stringify([input.inputKind, input.producerNodeId, shard])
    if (keys.has(key)) throw new Error('node-run-input-duplicate')
    keys.add(key)
    rows.push({
      taskId: run.taskId,
      consumerRunId: run.id,
      ordinal,
      producerRunId: input.producerRunId,
      producerRunRef: input.producerRunId,
      inputKind: input.inputKind,
      producerNodeId: input.producerNodeId,
      producerShardSlot: shard,
      provenanceQuality: 'recorded',
      evidenceRefJson: null,
    })
  }
  await tx.delete(nodeRunInputs).where(eq(nodeRunInputs.consumerRunId, run.id))
  for (const row of rows) await insertOne(tx, nodeRunInputs, row)
  await tx
    .update(nodeRuns)
    .set({ inputsRecorded: inputs !== null })
    .where(eq(nodeRuns.id, run.id))
}

async function companions(
  tx: PersistenceTx,
  run: Run,
  write: NodeRunTableWrite,
  mounts: readonly TaskMountKey[],
) {
  const {
    nodeRunConfigs: configs,
    nodeRunRuntimeStates: runtime,
    nodeRunResults: results,
  } = tablesOf(tx)
  if (write.config && Object.values(write.config).some((value) => value !== undefined)) {
    const [old] = await tx.select().from(configs).where(eq(configs.nodeRunId, run.id)).limit(1)
    if (old) await tx.update(configs).set(write.config).where(eq(configs.nodeRunId, run.id))
    else if (nodeRunRowPresence({ ...run, config: write.config }).config)
      await insertOne(tx, configs, { nodeRunId: run.id, ...write.config })
  }
  if (write.runtime && Object.values(write.runtime).some((value) => value !== undefined)) {
    const [old] = await tx.select().from(runtime).where(eq(runtime.nodeRunId, run.id)).limit(1)
    if (old) await tx.update(runtime).set(write.runtime).where(eq(runtime.nodeRunId, run.id))
    else if (nodeRunRowPresence({ ...run, runtime: write.runtime }).runtimeState)
      await insertOne(tx, runtime, { nodeRunId: run.id, ...write.runtime })
  }
  if (write.result && Object.values(write.result).some((value) => value !== undefined)) {
    const [old] = await tx.select().from(results).where(eq(results.nodeRunId, run.id)).limit(1)
    if (old) await tx.update(results).set(write.result).where(eq(results.nodeRunId, run.id))
    else if (nodeRunRowPresence({ ...run, result: write.result }).result)
      await insertOne(tx, results, { nodeRunId: run.id, ...write.result })
  }
  if (write.checkpoint) await writeCheckpoints(tx, run, write.checkpoint, mounts)
  if (write.inputs !== undefined) await replaceInputs(tx, run, write.inputs)
}

/**
 * RFC-395 D13: a reshaped companion table takes only its own columns. Drizzle drops unknown keys
 * without an error, so a wider payload (a legacy row, a DTO field that moved tables) would lose
 * its value silently; reject it before any statement runs.
 */
function requireOwnColumns(tx: PersistenceTx, write: NodeRunTableWrite): void {
  const tables = tablesOf(tx)
  for (const [part, table, values] of [
    ['config', tables.nodeRunConfigs, write.config],
    ['runtime', tables.nodeRunRuntimeStates, write.runtime],
    ['result', tables.nodeRunResults, write.result],
  ] as const) {
    if (values === undefined) continue
    const columns = getTableColumns(table)
    for (const key of Object.keys(values))
      if (!Object.hasOwn(columns, key))
        throw new Error(`node-run-write-unknown-column:${part}.${key}`)
  }
}

async function prepare(tx: PersistenceTx, nodeRunId: string, write: NodeRunTableWrite) {
  requireOwnColumns(tx, write)
  const { nodeRuns } = tablesOf(tx)
  const [located] = await tx
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  if (!located) throw new NotFoundError('node-run-not-found', `node_run ${nodeRunId} not found`)
  const mounts = write.checkpoint ? await taskMountKeysReader.list(tx, located.taskId) : []
  const run = await lockRun(tx, nodeRunId)
  return { run, mounts }
}

/** All writers below require the caller's owner fence (when owned) and task root lock.
 * No helper reacquires the root after a node_runs write. All statements share the owner transaction. */
export async function writeNodeRunTablesInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  write: NodeRunTableWrite,
): Promise<void> {
  const { run, mounts } = await prepare(tx, nodeRunId, write)
  await companions(tx, run, write, mounts)
}

export async function compareAndWriteNodeRunInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  predicate: SQL,
  identity: NodeRunIdentityPatch,
  write: NodeRunTableWrite = {},
): Promise<void> {
  const { run, mounts } = await prepare(tx, nodeRunId, write)
  const { nodeRuns } = tablesOf(tx)
  // rfc053-allow-direct-status-write — the identity CAS owns all normal lifecycle changes.
  const rows = await tx
    .update(nodeRuns)
    .set(identity)
    .where(and(eq(nodeRuns.id, nodeRunId), predicate))
    .returning({ id: nodeRuns.id })
  if (rows.length !== 1)
    throw new ConflictError(
      'concurrent-node-run-transition',
      `node_run ${nodeRunId} changed concurrently`,
    )
  await companions(tx, run, write, mounts)
}

export async function compareAndWriteMergeStateInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  from: MergeStateOrNull,
  to: MergeStateOrNull,
  write: NodeRunTableWrite = {},
): Promise<void> {
  const { run, mounts } = await prepare(tx, nodeRunId, write)
  const { nodeRunRuntimeStates: runtime } = tablesOf(tx)
  const [existing] = await tx
    .select({ mergeState: runtime.mergeState })
    .from(runtime)
    .where(eq(runtime.nodeRunId, nodeRunId))
    .limit(1)
  if (!existing) {
    if (from !== null)
      throw new ConflictError(
        'concurrent-merge-state-transition',
        'merge state changed concurrently',
      )
    if (
      nodeRunRowPresence({ ...run, runtime: { ...write.runtime, mergeState: to } }).runtimeState
    ) {
      const inserted = await tx
        .insert(runtime)
        .values({ nodeRunId, ...write.runtime, mergeState: to })
        .onConflictDoNothing({ target: runtime.nodeRunId })
        .returning({ id: runtime.nodeRunId })
      if (inserted.length !== 1)
        throw new ConflictError(
          'concurrent-merge-state-transition',
          'merge state changed concurrently',
        )
    }
  } else {
    // rfc144-allow-direct-merge-state-write — the only runtime merge-state UPDATE is this CAS.
    const rows = await tx
      .update(runtime)
      .set({ ...write.runtime, mergeState: to })
      .where(
        and(
          eq(runtime.nodeRunId, nodeRunId),
          from === null ? isNull(runtime.mergeState) : eq(runtime.mergeState, from),
        ),
      )
      .returning({ id: runtime.nodeRunId })
    if (rows.length !== 1)
      throw new ConflictError(
        'concurrent-merge-state-transition',
        'merge state changed concurrently',
      )
  }
  await companions(tx, run, { ...write, runtime: undefined }, mounts)
}

/** RFC-397: session predicates use READ COMMITTED + owner fence + task root + lockRun.
 * Identity-free relabels also preserve the session lineage of history-only rows. */
export async function compareAndWriteRunSessionInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  expected: string | null,
  sessionId: string | null,
  identity?: { readonly taskId: string; readonly nodeId: string; readonly status: Run['status'] },
): Promise<boolean> {
  const { nodeRuns } = tablesOf(tx)
  const [located] = await tx
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  if (!located || (identity && located.taskId !== identity.taskId)) return false
  const run = await lockRun(tx, nodeRunId, identity !== undefined)
  if (
    identity &&
    (run.taskId !== identity.taskId ||
      run.nodeId !== identity.nodeId ||
      run.status !== identity.status)
  )
    return false
  const { nodeRunRuntimeStates: runtime } = tablesOf(tx)
  const [state] = await tx
    .select({ sessionId: runtime.sessionId })
    .from(runtime)
    .where(eq(runtime.nodeRunId, nodeRunId))
    .limit(1)
  if ((state?.sessionId ?? null) !== expected) return false
  if (!state) {
    if (sessionId !== null) await insertOne(tx, runtime, { nodeRunId, sessionId })
    return true
  }
  const rows = await tx
    .update(runtime)
    .set({ sessionId })
    .where(
      and(
        eq(runtime.nodeRunId, nodeRunId),
        expected === null ? isNull(runtime.sessionId) : eq(runtime.sessionId, expected),
      ),
    )
    .returning({ id: runtime.nodeRunId })
  return rows.length === 1
}

/** Translate stable DTO names at the edge; content is prepared by X outside the transaction. */
export function nodeRunTableWrite(
  write: NodeRunProjectionWrite | NodeRunLifecycleWrite,
  prompt?: ContentRef | null,
): NodeRunTableWrite {
  const config = 'config' in write ? write.config : undefined
  const { promptText, promptPath, ...configValues } = config ?? {}
  if ((promptText !== undefined || promptPath !== undefined) && prompt === undefined)
    throw new Error('node-run-prompt-reference-required')
  const encoded = prompt === undefined || prompt === null ? null : contentRefColumns.encode(prompt)
  const runtimeWrite: NonNullable<NodeRunProjectionWrite['runtime']> = write.runtime ?? {}
  const { opencodeSessionId, isoWorktreePath, ...runtime } = runtimeWrite
  return {
    config: {
      ...configValues,
      ...(prompt === undefined
        ? {}
        : {
            promptRefJson: encoded?.json ?? null,
            promptInlineBytes:
              encoded?.inlineBytes == null ? null : Buffer.from(encoded.inlineBytes),
          }),
    },
    runtime: {
      ...runtime,
      ...(opencodeSessionId === undefined ? {} : { sessionId: opencodeSessionId }),
      ...(isoWorktreePath === undefined ? {} : { isolationRootRef: isoWorktreePath }),
    },
    result: write.result,
    checkpoint: 'checkpoint' in write ? write.checkpoint : undefined,
    inputs:
      write.inputs?.recordedInputs !== undefined
        ? write.inputs.recordedInputs
        : write.inputs?.consumedUpstreamRunsJson === undefined
          ? undefined
          : write.inputs.consumedUpstreamRunsJson === null
            ? null
            : decodeConsumedEdges(write.inputs.consumedUpstreamRunsJson).map((edge) => ({
                ...edge,
                inputKind: 'frame-input' as const,
              })),
  }
}

/** Projection identity and companions are one owner transaction as well. */
export async function writeNodeRunProjectionInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  write: NodeRunProjectionWrite,
  prompt?: ContentRef | null,
): Promise<void> {
  const companions = nodeRunTableWrite(write, prompt)
  if (write.identity && Object.values(write.identity).some((value) => value !== undefined)) {
    const { nodeRuns } = tablesOf(tx)
    await compareAndWriteNodeRunInTx(
      tx,
      nodeRunId,
      eq(nodeRuns.id, nodeRunId),
      write.identity,
      companions,
    )
  } else await writeNodeRunTablesInTx(tx, nodeRunId, companions)
}
