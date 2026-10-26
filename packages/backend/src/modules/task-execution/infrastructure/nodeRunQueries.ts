import { projectNodeRunDisplayValues } from '../domain/nodeRunDisplayProjection'
import { readNodeRunLegacyEvidence, type NodeRunEvidenceContent } from './nodeRunLegacyEvidence'
import { decodeCanonicalRunSlot } from '../domain/runSelection/slotKey'
import {
  databaseSessionFor,
  databaseTransactionIsActive,
  engineOf,
} from '@/platform/persistence/databaseTransaction'
import {
  getTableColumns,
  type Column,
  type GetColumnData,
  type SQLWrapper,
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  sql,
  type AnyColumn,
} from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { type ContentStore, contentRefColumns } from '@/platform/content/contentStore'

import { readDatabaseContent } from '@/platform/content/infrastructure/contentStore'
import type { NodeRunStatus } from '@agent-workflow/shared'
import type {
  NodeRunFactSnapshot,
  NodeRunHistoryFactSnapshot,
  NodeRunFactsQuery,
  NodeRunQueries,
} from '../application/ports/nodeRunQueries'
import {
  type NodeRunSnapshotRows,
  projectNodeRunReadFacts,
  projectNodeRunHistoryFacts,
} from './nodeRunSnapshot'

import { humanGateCheckpointProjectionMember } from './humanGateProjection'

/** Scalar projections keep narrow reads in one statement; bytes and inputs are loaded explicitly. */
export function nodeRunReadColumns(db: object) {
  const {
    nodeRuns: r,
    nodeRunConfigs: c,
    nodeRunRuntimeStates: s,
    nodeRunResults: o,
  } = tablesOf(db)
  const field = <C extends Column>(column: C, table: SQLWrapper, id: SQLWrapper) =>
    sql<GetColumnData<C>>`(select ${column} from ${table} where ${id} = ${r.id})`.mapWith(column)
  return {
    ...getTableColumns(r),
    slot: sql<string>`${r.slotKey}`.mapWith(decodeCanonicalRunSlot),
    retryIndex: r.attemptIndex,
    parentNodeRunId: r.historicalParentId,
    runtime: field(c.runtime, c, c.nodeRunId),
    runtimeBinary: field(c.runtimeBinary, c, c.nodeRunId),
    runtimeParamsJson: field(c.runtimeParamsJson, c, c.nodeRunId),
    runtimeInventoryJson: field(c.runtimeInventoryJson, c, c.nodeRunId),
    inventorySnapshotJson: field(c.inventorySnapshotJson, c, c.nodeRunId),
    injectedMemoriesJson: field(c.injectedMemoriesJson, c, c.nodeRunId),
    agentOverrideName: field(c.agentOverrideName, c, c.nodeRunId),
    agentOverrideId: field(c.agentOverrideId, c, c.nodeRunId),
    shardValueHash: field(c.shardValueHash, c, c.nodeRunId),
    pid: field(s.pid, s, s.nodeRunId),
    spawnBinaryPath: field(s.spawnBinaryPath, s, s.nodeRunId),
    spawnLaunchNonce: field(s.spawnLaunchNonce, s, s.nodeRunId),
    opencodeSessionId: field(s.sessionId, s, s.nodeRunId),
    startupVerificationJson: field(s.startupVerificationJson, s, s.nodeRunId),
    wrapperProgressJson: field(s.wrapperProgressJson, s, s.nodeRunId),
    isoWorktreePath: field(s.isolationRootRef, s, s.nodeRunId),
    mergeState: field(s.mergeState, s, s.nodeRunId),
    tokInput: field(o.tokInput, o, o.nodeRunId),
    tokOutput: field(o.tokOutput, o, o.nodeRunId),
    tokCacheCreate: field(o.tokCacheCreate, o, o.nodeRunId),
    tokCacheRead: field(o.tokCacheRead, o, o.nodeRunId),
    tokTotal: field(o.tokTotal, o, o.nodeRunId),
    portValidationFailuresJson: field(o.portValidationFailuresJson, o, o.nodeRunId),
    commitPushJson: field(o.commitPushJson, o, o.nodeRunId),
    supersededByReview: field(o.supersededByReview, o, o.nodeRunId),
    rolledBack: field(o.rolledBack, o, o.nodeRunId),
  }
}

function nodeRunFactsWhere(db: object, input: NodeRunFactsQuery) {
  const { nodeRuns: run } = tablesOf(db)
  return and(
    input.taskIds === undefined ? undefined : inArray(run.taskId, [...input.taskIds]),
    input.taskId === undefined ? undefined : eq(run.taskId, input.taskId),
    input.nodeId === undefined ? undefined : eq(run.nodeId, input.nodeId),
    input.nodeIds === undefined ? undefined : inArray(run.nodeId, [...input.nodeIds]),
    input.iteration === undefined ? undefined : eq(run.iteration, input.iteration),
    input.runIds === undefined ? undefined : inArray(run.id, [...input.runIds]),
    input.shardKey === undefined
      ? undefined
      : input.shardKey === null
        ? isNull(run.shardKey)
        : eq(run.shardKey, input.shardKey),
    input.parentNodeRunId === undefined
      ? undefined
      : input.parentNodeRunId === null
        ? isNull(run.historicalParentId)
        : eq(run.historicalParentId, input.parentNodeRunId),
    input.reviewIteration === undefined
      ? undefined
      : eq(run.reviewIteration, input.reviewIteration),
    input.status === undefined ? undefined : eq(run.status, input.status),
  )
}

/** Read all companions in bounded batches; never reconstruct a checkpoint from scalar mirrors. */
export async function readNodeRunRows(
  db: PersistenceDb,
  input: NodeRunFactsQuery & { readonly executableOnly?: boolean },
): Promise<(NodeRunSnapshotRows & { readonly evidence: NodeRunEvidenceContent | null })[]> {
  return databaseTransactionIsActive(db)
    ? readNodeRunRowsInSnapshot(db, input)
    : databaseSessionFor(db).snapshotRead((tx) => readNodeRunRowsInSnapshot(tx, input))
}

async function readNodeRunRowsInSnapshot(
  db: PersistenceDb,
  input: NodeRunFactsQuery & { readonly executableOnly?: boolean },
): Promise<(NodeRunSnapshotRows & { readonly evidence: NodeRunEvidenceContent | null })[]> {
  if (input.taskIds?.length === 0 || input.runIds?.length === 0 || input.nodeIds?.length === 0)
    return []
  const {
    nodeRuns: run,
    nodeRunConfigs: config,
    nodeRunRuntimeStates: runtime,
    nodeRunResults: result,
    nodeRunRepoCheckpoints: checkpoint,
    taskRepositoryMounts: mounts,
    nodeRunInputs: inputs,
    executionLegacyEvidence: evidence,
  } = tablesOf(db)
  const query = db
    .select({
      run,
      config,
      runtime,
      result,
      evidence: {
        contentRefJson: evidence.contentRefJson,
        contentInlineBytes: evidence.contentInlineBytes,
      },
    })
    .from(run)
    .leftJoin(config, eq(config.nodeRunId, run.id))
    .leftJoin(runtime, eq(runtime.nodeRunId, run.id))
    .leftJoin(result, eq(result.nodeRunId, run.id))
    .leftJoin(
      evidence,
      and(
        eq(evidence.taskId, run.taskId),
        eq(evidence.recordKind, 'node-run'),
        eq(evidence.recordId, run.id),
      ),
    )
    .where(
      and(
        nodeRunFactsWhere(db, input),
        input.executableOnly === true ? eq(run.recordMode, 'executable') : undefined,
      ),
    )
  const ordered =
    input.order === undefined
      ? query
      : query.orderBy(
          ...(input.order === 'retry-desc' ? [engineOf(db).descNullsLast(run.attemptIndex)] : []),
          input.order === 'seq-asc' ? asc(run.seq) : desc(run.seq),
        )
  const rows = await (input.limit === undefined ? ordered : ordered.limit(input.limit))
  if (rows.length === 0) return []
  const checkpoints = new Map<string, NodeRunSnapshotRows['checkpoints'][number][]>()
  const edges = new Map<string, NodeRunSnapshotRows['inputs'][number][]>()
  for (let offset = 0; offset < rows.length; offset += 400) {
    const ids = rows.slice(offset, offset + 400).map((row) => row.run.id)
    const stored = await db
      .select({
        nodeRunId: checkpoint.nodeRunId,
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
      .where(inArray(checkpoint.nodeRunId, ids))
      .orderBy(asc(mounts.ordinal))
    for (const row of stored) {
      const values = checkpoints.get(row.nodeRunId) ?? []
      values.push({
        mountPath: row.mountPath,
        ...(row.preSnapshot === null ? {} : { preSnapshot: row.preSnapshot }),
        ...(row.isolationBase === null ? {} : { isolationBase: row.isolationBase }),
        ...(row.nodeTree === null ? {} : { nodeTree: row.nodeTree }),
        ...(row.submodules === null ? {} : { submodules: JSON.parse(row.submodules) }),
      })
      checkpoints.set(row.nodeRunId, values)
    }
    for (const row of await db
      .select({
        consumerRunId: inputs.consumerRunId,
        producerNodeId: inputs.producerNodeId,
        producerRunId: inputs.producerRunId,
      })
      .from(inputs)
      .where(and(inArray(inputs.consumerRunId, ids), eq(inputs.inputKind, 'frame-input')))
      .orderBy(asc(inputs.ordinal))) {
      const values = edges.get(row.consumerRunId) ?? []
      values.push({ producerNodeId: row.producerNodeId, producerRunId: row.producerRunId })
      edges.set(row.consumerRunId, values)
    }
  }
  return rows.map((row) => ({
    ...row,
    checkpoints: checkpoints.get(row.run.id) ?? [],
    inputs: edges.get(row.run.id) ?? [],
  }))
}

export async function projectNodeRunFacts(
  rows: NodeRunSnapshotRows,
  content: Pick<ContentStore, 'read'>,
): Promise<NodeRunFactSnapshot> {
  const ref = contentRefColumns.decode(
    rows.config?.promptRefJson ?? null,
    rows.config?.promptInlineBytes ?? null,
  )
  const promptText =
    ref && ref.kind !== 'inline' && !(ref.kind === 'local-file' && ref.location.codec === 'prompt')
      ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await content.read(ref))
      : null
  const {
    checkpoints: _checkpoints,
    checkpointInheritance: _inheritance,
    ...facts
  } = projectNodeRunReadFacts(rows, promptText)
  return facts
}

export function createNodeRunQueries(
  db: PersistenceDb,
  content: Pick<ContentStore, 'read'> = { read: (ref) => readDatabaseContent(db, ref) },
): NodeRunQueries {
  async function listWithCheckpoints(input: NodeRunFactsQuery) {
    const rows = await readNodeRunRows(db, { ...input, executableOnly: true })
    return Promise.all(
      rows.map(async (row) => ({
        ...(await projectNodeRunFacts(row, content)),
        checkpoints: row.checkpoints,
        checkpointInheritance: row.checkpoints.flatMap(({ mountPath, preSnapshot }) =>
          preSnapshot === undefined ? [] : [{ mountPath, preSnapshot }],
        ),
        rollback: {
          id: row.run.id,
          checkpoints: row.checkpoints,
        },
      })),
    )
  }
  async function listFields<K extends keyof NodeRunFactSnapshot>(
    input: NodeRunFactsQuery,
    fields: readonly K[],
    executableOnly: boolean,
  ): Promise<readonly Pick<NodeRunHistoryFactSnapshot, K>[]> {
    if (input.taskIds?.length === 0 || input.runIds?.length === 0 || input.nodeIds?.length === 0)
      return []
    const columns = nodeRunReadColumns(db)
    const promptFields = fields.includes('promptText' as K) || fields.includes('promptPath' as K)
    if (
      (executableOnly || input.order !== 'retry-desc') &&
      fields.every(
        (field) =>
          Object.hasOwn(columns, field) || field === 'promptText' || field === 'promptPath',
      )
    ) {
      const { nodeRuns, nodeRunConfigs, executionLegacyEvidence: evidence } = tablesOf(db)
      const historySelection = {
        historyRun: {
          id: nodeRuns.id,
          taskId: nodeRuns.taskId,
          recordMode: nodeRuns.recordMode,
          role: nodeRuns.role,
          slotKey: nodeRuns.slotKey,
          attemptIndex: nodeRuns.attemptIndex,
          scopePath: nodeRuns.scopePath,
        },
        historyEvidence: {
          contentRefJson: evidence.contentRefJson,
          contentInlineBytes: evidence.contentInlineBytes,
        },
      }
      const selection = {
        ...(executableOnly ? {} : historySelection),
        ...Object.fromEntries(
          fields
            .filter((field) => field !== 'promptText' && field !== 'promptPath')
            .map((field) => [field, columns[field as keyof typeof columns]]),
        ),
        ...(promptFields
          ? {
              promptRefJson: sql<
                string | null
              >`(select ${nodeRunConfigs.promptRefJson} from ${nodeRunConfigs} where ${nodeRunConfigs.nodeRunId} = ${nodeRuns.id})`,
              promptInlineBytes: sql<Uint8Array | null>`(select ${nodeRunConfigs.promptInlineBytes} from ${nodeRunConfigs} where ${nodeRunConfigs.nodeRunId} = ${nodeRuns.id})`,
            }
          : {}),
      }
      const baseQuery = db.select(selection).from(nodeRuns)
      const query = (
        executableOnly
          ? baseQuery
          : baseQuery.leftJoin(
              evidence,
              and(
                eq(evidence.taskId, nodeRuns.taskId),
                eq(evidence.recordKind, 'node-run'),
                eq(evidence.recordId, nodeRuns.id),
              ),
            )
      ).where(
        and(
          nodeRunFactsWhere(db, input),
          executableOnly ? eq(nodeRuns.recordMode, 'executable') : undefined,
        ),
      )
      const ordered =
        input.order === undefined
          ? query
          : query.orderBy(
              ...(input.order === 'retry-desc'
                ? [engineOf(db).descNullsLast(nodeRuns.attemptIndex)]
                : []),
              input.order === 'seq-asc' ? asc(nodeRuns.seq) : desc(nodeRuns.seq),
            )
      const rows = await (input.limit === undefined ? ordered : ordered.limit(input.limit))
      return await Promise.all(
        rows.map(async (row) => {
          const value: Record<string, unknown> = { ...row }
          if (promptFields) {
            const ref = contentRefColumns.decode(
              row.promptRefJson ?? null,
              row.promptInlineBytes ?? null,
            )
            const legacy =
              ref?.kind === 'local-file' && ref.location.codec === 'prompt'
                ? ref.location.value
                : null
            if (fields.includes('promptText' as K))
              value.promptText =
                ref === null || legacy !== null
                  ? null
                  : new TextDecoder('utf-8', { ignoreBOM: true }).decode(
                      ref.kind === 'inline' ? ref.bytes : await content.read(ref),
                    )
            if (fields.includes('promptPath' as K))
              value.promptPath =
                legacy !== null &&
                typeof legacy === 'object' &&
                'promptPath' in legacy &&
                typeof legacy.promptPath === 'string'
                  ? legacy.promptPath
                  : null
            delete value.promptRefJson
            delete value.promptInlineBytes
          }
          delete value.historyRun
          delete value.historyEvidence
          return projectNodeRunDisplayValues(
            value,
            row.historyRun === undefined
              ? null
              : await readNodeRunLegacyEvidence(
                  row.historyRun,
                  row.historyEvidence ?? null,
                  content,
                ),
            row.historyRun?.id ?? (typeof value.id === 'string' ? value.id : ''),
          ) as unknown as Pick<NodeRunHistoryFactSnapshot, K>
        }),
      )
    }
    return (await (executableOnly ? queries.list(input) : queries.listHistory(input))).map(
      (row) =>
        Object.fromEntries(fields.map((field) => [field, row[field]])) as Pick<
          NodeRunHistoryFactSnapshot,
          K
        >,
    )
  }

  const queries: NodeRunQueries = {
    async heldSession(runId) {
      const { runtimeSessionLeases } = tablesOf(db)
      return (
        await db
          .select({ sessionId: runtimeSessionLeases.sessionId })
          .from(runtimeSessionLeases)
          .where(eq(runtimeSessionLeases.leaseNodeRunId, runId))
          .limit(1)
      )[0]
    },
    async heldSessionRunIds(taskId) {
      const { runtimeSessionLeases } = tablesOf(db)
      const rows = await db
        .select({ nodeRunId: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.taskId, taskId),
            isNotNull(runtimeSessionLeases.leaseNodeRunId),
          ),
        )
      return [...new Set(rows.flatMap((row) => (row.nodeRunId === null ? [] : [row.nodeRunId])))]
    },
    async listResumeRuns(taskId) {
      return listWithCheckpoints({ taskId })
    },
    async humanGateProjection(runIds) {
      const rows = await listWithCheckpoints({ runIds })
      const { taskRepositoryMounts } = tablesOf(db)
      if (rows.length === 0) return []
      const mounts = await db
        .select({ taskId: taskRepositoryMounts.taskId, mountPath: taskRepositoryMounts.mountPath })
        .from(taskRepositoryMounts)
        .where(inArray(taskRepositoryMounts.taskId, [...new Set(rows.map((row) => row.taskId))]))
        .orderBy(asc(taskRepositoryMounts.ordinal))
      return rows.map((row) =>
        humanGateCheckpointProjectionMember(
          row,
          mounts.filter((mount) => mount.taskId === row.taskId).map((mount) => mount.mountPath),
        ),
      )
    },
    async listDispatchFacts(input) {
      return queries.listFields(input, [
        'id',
        'seq',
        'taskId',
        'nodeId',
        'status',
        'iteration',
        'retryIndex',
        'parentNodeRunId',
        'childTaskId',
        'shardKey',
        'wgRound',
        'reviewIteration',
        'mergeState',
        'forceActivated',
        'startedAt',
        'finishedAt',
        'pid',
        'exitCode',
        'errorMessage',
        'failureCode',
        'opencodeSessionId',
        'rerunCause',
        'supersededByReview',
        'rolledBack',
      ])
    },
    async listHistoryDispatchFacts(input) {
      return queries.listHistoryFields(input, [
        'id',
        'seq',
        'taskId',
        'nodeId',
        'status',
        'iteration',
        'retryIndex',
        'parentNodeRunId',
        'childTaskId',
        'shardKey',
        'wgRound',
        'reviewIteration',
        'mergeState',
        'forceActivated',
        'startedAt',
        'finishedAt',
        'pid',
        'exitCode',
        'errorMessage',
        'failureCode',
        'opencodeSessionId',
        'rerunCause',
        'supersededByReview',
        'rolledBack',
      ])
    },
    async latestPerNode(taskIds) {
      const rows = await queries.listFields({ taskIds, order: 'seq-desc' }, [
        'taskId',
        'nodeId',
        'status',
        'retryIndex',
        'finishedAt',
        'id',
      ])
      const seen = new Set<string>()
      return rows
        .filter((row) => {
          const key = JSON.stringify([row.taskId, row.nodeId])
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .reverse()
    },
    async latestHistoryPerNode(taskIds) {
      const rows = await queries.listHistoryFields({ taskIds, order: 'seq-desc' }, [
        'taskId',
        'nodeId',
        'status',
        'retryIndex',
        'finishedAt',
        'id',
      ])
      const seen = new Set<string>()
      return rows
        .filter((row) => {
          const key = JSON.stringify([row.taskId, row.nodeId])
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .reverse()
    },
    async read(runId) {
      return (await queries.list({ runIds: [runId], limit: 1 }))[0] ?? null
    },
    async list(input) {
      return Promise.all(
        (await readNodeRunRows(db, { ...input, executableOnly: true })).map((row) =>
          projectNodeRunFacts(row, content),
        ),
      )
    },
    async readFields(runId, fields) {
      return (await queries.listFields({ runIds: [runId], limit: 1 }, fields))[0] ?? null
    },
    async listFields(input, fields) {
      return (await listFields(input, fields, true)) as readonly Pick<
        NodeRunFactSnapshot,
        (typeof fields)[number]
      >[]
    },
    listHistoryFields: (input, fields) => listFields(input, fields, false),
    async listHistory(input) {
      const history = await Promise.all(
        (
          await readNodeRunRows(
            db,
            input.order === 'retry-desc' ? { ...input, limit: undefined } : input,
          )
        ).map(async (rows) => {
          const ref = contentRefColumns.decode(
            rows.config?.promptRefJson ?? null,
            rows.config?.promptInlineBytes ?? null,
          )
          const promptText =
            ref &&
            ref.kind !== 'inline' &&
            !(ref.kind === 'local-file' && ref.location.codec === 'prompt')
              ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await content.read(ref))
              : null
          return projectNodeRunDisplayValues(
            projectNodeRunHistoryFacts(rows, promptText),
            await readNodeRunLegacyEvidence(rows.run, rows.evidence, content),
            rows.run.id,
          )
        }),
      )
      if (input.order === 'retry-desc')
        history.sort((a, b) => b.retryIndex - a.retryIndex || b.seq - a.seq)
      return input.limit === undefined ? history : history.slice(0, input.limit)
    },
    async readWithCheckpoints(runId) {
      return (await listWithCheckpoints({ runIds: [runId], limit: 1 }))[0] ?? null
    },
    listWithCheckpoints,
  }
  return queries
}

export function nodeRunStatusCondition(db: PersistenceDb, runId: AnyColumn, status: NodeRunStatus) {
  const { nodeRuns } = tablesOf(db)
  return exists(
    db
      .select({ one: sql`1` })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.id, runId), eq(nodeRuns.status, status))),
  )
}
