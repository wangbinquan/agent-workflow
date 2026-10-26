import { childScopePath } from '@/modules/task-execution/domain/environmentChain'
import { nodeRunFixtureIdentity } from './identity'
// Runs retain public fixture inputs while their identity, companions and selection are target rows.
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  sql,
  type Column,
  type GetColumnData,
  type SQLWrapper,
} from 'drizzle-orm'
import { nodeRunLineageColumns } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import { nodeRunRowPresence } from '@/modules/task-execution/domain/nodeRunRowPresence'
import { decodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { producerShardSlot } from '@/modules/task-execution/domain/runInputShard'
import {
  readNodeRunSnapshotRows,
  projectNodeRunReadFacts,
} from '@/modules/task-execution/infrastructure/nodeRunSnapshot'
import { taskReadColumns } from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRefColumns } from '@/platform/content/contentStore'
import { inlineContentColumns } from '@/platform/content/infrastructure/contentStore'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import {
  createFixtureAdapter,
  encodeFixture,
  physicalFixtureValues,
  type FixtureHandle,
  type FixturePatch,
} from './core'
import type { RunCheckpointFixture, ConsumedEdgeFixture } from './checkpoint'
import type { NodeRunFixtureSpec } from './nodeRun.spec'
export type { NodeRunFixtureSpec } from './nodeRun.spec'
type Run = PersistenceTables['nodeRuns']['$inferSelect']
export type NodeRunFixtureRow = Omit<
  ReturnType<typeof projectNodeRunReadFacts>,
  | 'injectedMemoriesJson'
  | 'portValidationFailuresJson'
  | 'commitPushJson'
  | 'consumedUpstreamRunsJson'
  | 'seq'
> & {
  seq: number
  injectedMemories: string | null
  portValidationFailures: string | null
  commitPush: string | null
  consumedEdges: ConsumedEdgeFixture[] | undefined
  checkpoints: RunCheckpointFixture[]
}
/** SQL predicates and old query oracles read the split facts without writing a legacy root. */
export function nodeRunFixtureColumns(db: object) {
  const {
    nodeRuns: r,
    nodeRunConfigs: c,
    nodeRunRuntimeStates: s,
    nodeRunResults: o,
  } = tablesOf(db)
  const field = <C extends Column>(column: C, table: SQLWrapper, id: SQLWrapper) =>
    sql<GetColumnData<C>>`(select ${column} from ${table} where ${id} = ${r.id})`.mapWith(column)
  const config = <C extends Column>(column: C) => field(column, c, c.nodeRunId)
  const runtime = <C extends Column>(column: C) => field(column, s, s.nodeRunId)
  const result = <C extends Column>(column: C) => field(column, o, o.nodeRunId)
  return {
    ...getTableColumns(r),
    promptText: config(c.promptInlineBytes).mapWith((bytes: Uint8Array) =>
      bytes == null ? null : Buffer.from(bytes).toString('utf8'),
    ),
    promptPath: config(c.promptRefJson).mapWith((raw: string) => {
      if (raw == null) return null
      const ref = JSON.parse(raw) as {
        location?: { codec?: string; value?: { promptPath?: string | null } }
      }
      return ref.location?.codec === 'prompt' ? (ref.location.value?.promptPath ?? null) : null
    }),
    parentNodeRunId: r.historicalParentId,
    retryIndex: r.attemptIndex,
    runtime: config(c.runtime),
    runtimeBinary: config(c.runtimeBinary),
    runtimeParamsJson: config(c.runtimeParamsJson),
    inventorySnapshotJson: config(c.inventorySnapshotJson),
    runtimeInventoryJson: config(c.runtimeInventoryJson),
    injectedMemoriesJson: config(c.injectedMemoriesJson),
    agentOverrideName: config(c.agentOverrideName),
    agentOverrideId: config(c.agentOverrideId),
    shardValueHash: config(c.shardValueHash),
    pid: runtime(s.pid),
    spawnBinaryPath: runtime(s.spawnBinaryPath),
    spawnLaunchNonce: runtime(s.spawnLaunchNonce),
    opencodeSessionId: runtime(s.sessionId),
    startupVerificationJson: runtime(s.startupVerificationJson),
    wrapperProgressJson: runtime(s.wrapperProgressJson),
    isoWorktreePath: runtime(s.isolationRootRef),
    mergeState: runtime(s.mergeState),
    tokInput: result(o.tokInput),
    tokOutput: result(o.tokOutput),
    tokCacheCreate: result(o.tokCacheCreate),
    tokCacheRead: result(o.tokCacheRead),
    tokTotal: result(o.tokTotal),
    portValidationFailuresJson: result(o.portValidationFailuresJson),
    commitPushJson: result(o.commitPushJson),
    supersededByReview: result(o.supersededByReview),
    rolledBack: result(o.rolledBack),
  }
}
async function companions(db: FixtureHandle, run: Run, spec: FixturePatch<NodeRunFixtureSpec>) {
  const t = tablesOf(db)
  const values = encodeFixture('node_runs', spec)
  const config = physicalFixtureValues(t.nodeRunConfigs, values)
  const runtime = physicalFixtureValues(t.nodeRunRuntimeStates, values)
  const result = physicalFixtureValues(t.nodeRunResults, values)
  if (spec.opencodeSessionId !== undefined) runtime.sessionId = spec.opencodeSessionId
  if (spec.isoWorktreePath !== undefined) runtime.isolationRootRef = spec.isoWorktreePath
  if (spec.promptText !== undefined || spec.promptPath !== undefined) {
    const content =
      typeof spec.promptText === 'string'
        ? inlineContentColumns(Buffer.from(spec.promptText, 'utf8'), 'text/plain')
        : typeof spec.promptPath === 'string'
          ? (() => {
              const ref = contentRefColumns.encode(
                legacyContentRef('prompt', 'local-file', {
                  promptText: null,
                  promptPath: spec.promptPath,
                }),
              )
              return { contentRefJson: ref.json, contentInlineBytes: null }
            })()
          : { contentRefJson: null, contentInlineBytes: null }
    config.promptRefJson = content.contentRefJson
    config.promptInlineBytes = content.contentInlineBytes
  }
  const presence = nodeRunRowPresence({
    role: run.role,
    recordMode: run.recordMode,
    config,
    runtime,
    result,
  })
  for (const [table, patch, present] of [
    [t.nodeRunConfigs, config, presence.config],
    [t.nodeRunRuntimeStates, runtime, presence.runtimeState],
    [t.nodeRunResults, result, presence.result],
  ] as const) {
    if (!Object.keys(patch).length) continue
    const [previous] = await db
      .select({ nodeRunId: table.nodeRunId })
      .from(table)
      .where(eq(table.nodeRunId, run.id))
    if (present || previous)
      await db
        .insert(table)
        .values({ ...patch, nodeRunId: run.id })
        .onConflictDoUpdate({ target: table.nodeRunId, set: patch })
  }
  if (Array.isArray(spec.checkpoints)) {
    const mounts = await db
      .select()
      .from(t.taskRepositoryMounts)
      .where(eq(t.taskRepositoryMounts.taskId, run.taskId))
      .orderBy(asc(t.taskRepositoryMounts.ordinal))
    if (spec.checkpoints.length === 0)
      await db
        .delete(t.nodeRunRepoCheckpoints)
        .where(eq(t.nodeRunRepoCheckpoints.nodeRunId, run.id))
    for (const checkpoint of spec.checkpoints) {
      const mount = mounts.find((item) => item.mountPath === checkpoint.mountPath)
      if (!mount) throw new Error('node-run-checkpoint-mount-missing:' + checkpoint.mountPath)
      const { mountPath: _path, ...fields } = checkpoint
      const patch = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          value === undefined ? null : key === 'submodules' ? JSON.stringify(value) : value,
        ]),
      )
      if (!Object.keys(patch).length) continue
      await db
        .insert(t.nodeRunRepoCheckpoints)
        .values({ nodeRunId: run.id, taskId: run.taskId, repoKey: mount.repoKey, ...patch })
        .onConflictDoUpdate({
          target: [t.nodeRunRepoCheckpoints.nodeRunId, t.nodeRunRepoCheckpoints.repoKey],
          set: patch,
        })
    }
  }
  if (Array.isArray(spec.consumedEdges)) {
    await db.delete(t.nodeRunInputs).where(eq(t.nodeRunInputs.consumerRunId, run.id))
    for (const [ordinal, edge] of spec.consumedEdges.entries()) {
      const producer = await first(
        db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, edge.producerRunId)),
      )
      if (producer && (producer.taskId !== run.taskId || producer.nodeId !== edge.producerNodeId))
        throw new Error('fixture-input-producer-mismatch')
      const shardKey =
        edge.producerShardKey === undefined ? (producer?.shardKey ?? null) : edge.producerShardKey
      if (producer && shardKey !== producer.shardKey)
        throw new Error('fixture-input-shard-mismatch')
      await db.insert(t.nodeRunInputs).values({
        taskId: run.taskId,
        consumerRunId: run.id,
        ordinal,
        producerNodeId: edge.producerNodeId,
        producerRunId: edge.producerRunId,
        producerRunRef: producer?.id ?? null,
        inputKind: 'frame-input',
        producerShardSlot: producerShardSlot(shardKey),
        provenanceQuality: producer ? 'recorded' : 'legacy-derived',
        evidenceRefJson: producer
          ? null
          : JSON.stringify({
              fixture: 'missing historical producer',
              producerRunId: edge.producerRunId,
            }),
      })
    }
    await db.update(t.nodeRuns).set({ inputsRecorded: true }).where(eq(t.nodeRuns.id, run.id))
  }
}
async function selectRun(db: FixtureHandle, run: Run) {
  if (run.slotKey === null || run.recordMode !== 'executable') return
  const { nodeRunSelections: selections, nodeRuns } = tablesOf(db)
  const current = await first(
    db
      .select()
      .from(selections)
      .where(and(eq(selections.taskId, run.taskId), eq(selections.slotKey, run.slotKey))),
  )
  if (current?.selectedRunId) {
    const previous = await first(
      db.select().from(nodeRuns).where(eq(nodeRuns.id, current.selectedRunId)),
    )
    const slot = decodeCanonicalRunSlot(run.slotKey)
    const prep = slot.kind === 'synthetic' && slot.syntheticKind === 'repo-prep'
    if (
      previous &&
      (prep && previous.attemptIndex !== run.attemptIndex
        ? previous.attemptIndex! > run.attemptIndex!
        : previous.seq > run.seq)
    )
      return
  }
  const values = {
    taskId: run.taskId,
    slotKey: run.slotKey,
    selectedRunId: run.id,
    revision: (current?.revision ?? 0) + 1,
    generationSeq: run.generationSeq,
    cause: 'fixture',
    selectedAt: run.startedAt ?? 0,
  }
  await db
    .insert(selections)
    .values(values)
    .onConflictDoUpdate({ target: [selections.taskId, selections.slotKey], set: values })
}
const adapter = createFixtureAdapter<
  NodeRunFixtureSpec,
  PersistenceTables['nodeRuns'],
  NodeRunFixtureRow
>({
  table: (db) => tablesOf(db).nodeRuns,
  physicalTable: 'node_runs',
  keys: ['id'],
  columns: nodeRunFixtureColumns,
  async prepare(db, row, spec, batch) {
    await taskAggregateWrite.lockTaskAggregateRoot(db, spec.taskId)
    const t = tablesOf(db)
    const task = await first(
      db.select(taskReadColumns(db)).from(t.tasks).where(eq(t.tasks.id, spec.taskId)),
    )
    if (!task) throw new Error('fixture-task-missing')
    let definition: { nodes?: { id: string; kind: string }[] } = {}
    try {
      definition = JSON.parse(task.workflowSnapshot) ?? {}
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // A corrupt historical workflow remains testable; it supplies no container identity facts.
    }
    const related = await db
      .select({
        nodeId: t.nodeRuns.nodeId,
        containerRunId: t.nodeRuns.containerRunId,
        rerunCause: t.nodeRuns.rerunCause,
      })
      .from(t.nodeRuns)
      .where(eq(t.nodeRuns.taskId, spec.taskId))
    const labels = [...related, ...batch.filter((item) => item.taskId === spec.taskId)]
    const container =
      labels.some((item) => item.containerRunId === spec.id) ||
      (definition.nodes?.some(
        (node) => node.id === spec.nodeId && node.kind.startsWith('wrapper-'),
      ) ??
        false)
    const identity = nodeRunFixtureIdentity(
      spec,
      container,
      labels.some((item) => item.nodeId === spec.nodeId && item.rerunCause === 'fanout-shard'),
    )
    const { nodeRunSeqAllocations } = tablesOf(db)
    if (spec.seq === undefined) {
      const allocation = await first(
        db
          .insert(nodeRunSeqAllocations)
          .values({ taskId: spec.taskId, nodeRunId: spec.id, allocatedAt: spec.startedAt ?? 0 })
          .returning({ seq: nodeRunSeqAllocations.seq }),
      )
      if (!allocation) throw new Error('node-run-seq-allocation-missing')
      row.seq = allocation.seq
    }
    const generation = await first(
      db
        .select()
        .from(t.taskExecutionGenerations)
        .where(eq(t.taskExecutionGenerations.taskId, spec.taskId))
        .orderBy(desc(t.taskExecutionGenerations.generationSeq))
        .limit(1),
    )
    if (!generation) throw new Error('fixture-task-generation-missing')
    const lineage = nodeRunLineageColumns(
      {
        nodeId: spec.nodeId,
        iteration: spec.iteration ?? 0,
        shardKey: spec.shardKey ?? null,
        continuationSlotKey: spec.continuationSlotKey ?? null,
        lineageSlotPathJson:
          typeof row.lineageSlotPathJson === 'string' ? row.lineageSlotPathJson : null,
      },
      task,
    )
    const parentFrame = spec.containerRunId
      ? await first(db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, spec.containerRunId)))
      : undefined
    const scopePath =
      spec.scopePath ??
      (parentFrame?.scopePath == null
        ? ''
        : childScopePath(parentFrame.scopePath, parentFrame.nodeId, spec.iteration ?? 0))
    Object.assign(row, identity, lineage, {
      scopePath,
      historicalParentId: spec.parentNodeRunId ?? null,
      attemptIndex: spec.retryIndex ?? 0,
      generationSeq: generation.generationSeq,
      inputsRecorded: spec.consumedEdges !== undefined,
      recordMode: spec.envelopeNonce === null ? 'history-only' : 'executable',
      provenanceQuality: 'recorded',
      envelopeNonce: spec.envelopeNonce === undefined ? 'fixture:' + spec.id : spec.envelopeNonce,
    })
    if (spec.continuationSlotKey === null) row.continuationSlotKey = null
    if (spec.lineageSlotPathJson === null) row.lineageSlotPathJson = null
  },
  async afterWrite(db, row, spec) {
    await companions(db, row, spec)
    await selectRun(db, row)
  },
  async afterPatch(db, row, spec) {
    const t = tablesOf(db)
    const patch = {
      ...(spec.retryIndex === undefined ? {} : { attemptIndex: spec.retryIndex }),
      ...(spec.parentNodeRunId === undefined ? {} : { historicalParentId: spec.parentNodeRunId }),
    }
    if (Object.keys(patch).length)
      await db.update(t.nodeRuns).set(patch).where(eq(t.nodeRuns.id, row.id))
    const identityFields = [
      'nodeId',
      'parentNodeRunId',
      'containerRunId',
      'iteration',
      'shardKey',
      'rerunCause',
      'wrapperProgressJson',
    ]
    if (identityFields.some((key) => key in spec)) {
      const current = await first(
        db.select(nodeRunFixtureColumns(db)).from(t.nodeRuns).where(eq(t.nodeRuns.id, row.id)),
      )
      if (!current) throw new Error('fixture-node-run-missing')
      const identity = nodeRunFixtureIdentity(
        {
          ...current,
          ...spec,
          id: row.id,
          taskId: row.taskId,
          nodeId: typeof spec.nodeId === 'string' ? spec.nodeId : current.nodeId,
        } as NodeRunFixtureSpec,
        current.role === 'container',
      )
      if (identity.slotKey !== row.slotKey)
        await db
          .update(t.nodeRunSelections)
          .set({ selectedRunId: null, revision: sql`${t.nodeRunSelections.revision} + 1` })
          .where(eq(t.nodeRunSelections.selectedRunId, row.id))
      await db.update(t.nodeRuns).set(identity).where(eq(t.nodeRuns.id, row.id))
    }
    await companions(db, row, spec)
    if (
      identityFields.some((key) => key in spec) ||
      spec.retryIndex !== undefined ||
      spec.seq !== undefined
    ) {
      const current = await first(db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, row.id)))
      if (current) await selectRun(db, current)
    }
  },
  async project(db, row) {
    const rows = await readNodeRunSnapshotRows(db, row.id)
    if (!rows) throw new Error('fixture-node-run-missing')
    const {
      injectedMemoriesJson,
      portValidationFailuresJson,
      commitPushJson,
      consumedUpstreamRunsJson: _inputs,
      ...facts
    } = projectNodeRunReadFacts(rows)
    const t = tablesOf(db)
    const edges = rows.run.inputsRecorded
      ? await db
          .select()
          .from(t.nodeRunInputs)
          .where(
            and(
              eq(t.nodeRunInputs.consumerRunId, row.id),
              eq(t.nodeRunInputs.inputKind, 'frame-input'),
            ),
          )
          .orderBy(asc(t.nodeRunInputs.ordinal))
      : undefined
    return {
      ...facts,
      seq: rows.run.seq,
      checkpoints: [...rows.checkpoints],
      injectedMemories: injectedMemoriesJson,
      portValidationFailures: portValidationFailuresJson,
      commitPush: commitPushJson,
      consumedEdges: edges?.map((edge) => ({
        producerNodeId: edge.producerNodeId,
        producerRunId: edge.producerRunId,
        producerShardKey:
          edge.producerShardSlot === 'shard-v1:none'
            ? null
            : (JSON.parse(edge.producerShardSlot.slice('shard-v1:key:'.length)) as string),
      })),
    }
  },
})
export const nodeRunFixture = adapter.insert
export const readNodeRunFixtures = adapter.read
export const patchNodeRunFixture = adapter.patch
