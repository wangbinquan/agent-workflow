import { ulid } from 'ulid'
import { decodePrompt } from '@/platform/content/locations/prompt'
import { type ContentStore, contentRefColumns } from '@/platform/content/contentStore'

import {
  databaseContentColumnsInTx,
  readDatabaseContent,
  releaseContentRowsInTx,
} from '@/platform/content/infrastructure/contentStore'
// RFC-359 W4-B1 批 2f —— node run 执行投影（快照 / 输出 / 事件）：一份实现，两个 provider 共用。
// 写路径是产品里最热的（agent 每吐一行就 appendEvents 一次）：统一写事务 + owner 围栏 + 聚合根行锁。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryWrite } from '@/platform/persistence/queryHelpers'
import { and, asc, count, eq, inArray, isNotNull, isNull, notLike, sql } from 'drizzle-orm'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { insertInBatches, lastPerKey } from '@/platform/persistence/batchInsert'
import {
  databaseSessionFor,
  databaseTransactionIsActive,
  engineOf,
} from '@/platform/persistence/databaseTransaction'
import type {
  NodeExecutionPersistence,
  NodeExecutionQuery,
  NodeExecutionSnapshot,
  NodeExecutionReadSnapshot,
} from '../application/ports/nodeExecutionPersistence'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import { readNodeRunSnapshot, projectNodeRunSnapshot } from './nodeRunSnapshot'
import { lockNodeRunTaskRootInTx, writeNodeRunProjectionInTx } from './nodeRunWriteProtocol'
import { readNodeRunRows, projectNodeRunFacts } from './nodeRunQueries'
import { createRunSelectionReader } from './runSelection/table/reader'
import { createRunSelectionParticipantInTx } from './runSelection/table/selectionWrite'
import {
  fenceTaskWrite,
  type TaskExecutionTransaction,
  withTaskExecutionWrite,
} from './ownedTaskExecution'

function whereQuery(db: PersistenceDb, input: NodeExecutionQuery) {
  const { nodeRuns, nodeRunRuntimeStates } = tablesOf(db)
  const conditions = [eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.recordMode, 'executable')]
  if (input.nodeId !== undefined) conditions.push(eq(nodeRuns.nodeId, input.nodeId))
  if (input.iteration !== undefined) conditions.push(eq(nodeRuns.iteration, input.iteration))
  if (input.status !== undefined) conditions.push(eq(nodeRuns.status, input.status))
  if (input.mergeState === null) conditions.push(isNull(nodeRunRuntimeStates.mergeState))
  else if (input.mergeState !== undefined) {
    conditions.push(eq(nodeRunRuntimeStates.mergeState, input.mergeState))
  }
  if (input.childOnly === true) conditions.push(isNotNull(nodeRuns.historicalParentId))
  if (input.parentNodeRunId === null) conditions.push(isNull(nodeRuns.historicalParentId))
  else if (input.parentNodeRunId !== undefined) {
    conditions.push(eq(nodeRuns.historicalParentId, input.parentNodeRunId))
  }
  // RFC-354 — one frame: null = the top scope, a run id = that wrapper generation's body.
  if (input.containerRunId === null) conditions.push(isNull(nodeRuns.containerRunId))
  else if (input.containerRunId !== undefined) {
    conditions.push(eq(nodeRuns.containerRunId, input.containerRunId))
  }
  return and(...conditions)
}

async function fencedTaskId(
  tx: TaskExecutionTransaction,
  nodeRunId: string,
  context: TaskExecutionContextRef | undefined,
  now: number,
): Promise<string | null> {
  const { nodeRuns } = tablesOf(tx)
  const rows = await tx
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const taskId = rows[0]?.taskId
  if (taskId === undefined) return null
  // 围栏规则两引擎同一（ownedTaskExecution）：显式上下文 > 环境上下文 > 无主围栏。
  await fenceTaskWrite(tx, { taskId, context, now })
  // 聚合根行锁（能力矩阵：PG 渲染 `select … for update`，SQLite 已独占、no-op）。这几个写事务在 PG 上
  // 跑 READ COMMITTED（实测见 `postgresqlTaskLifecycleTransaction.ts` 的 aggregate 说明），同一个
  // node run 的并发写手靠这把锁串起来。**必须在 owner fence 之后**：其余 owned 写手都是先 fence 再动
  // `node_runs`，反序取锁会和它们死锁。
  await lockNodeRunTaskRootInTx(tx, nodeRunId)
  await engineOf(tx).lockAggregateRoot(tx, nodeRuns, nodeRuns.id, nodeRunId)
  return taskId
}

export class DrizzleNodeExecutionPersistence implements NodeExecutionPersistence {
  get selection() {
    return createRunSelectionReader(this.db)
  }
  constructor(
    private readonly db: PersistenceDb,
    private readonly content: Pick<ContentStore, 'read'> = {
      read: (ref) => readDatabaseContent(db, ref),
    },
  ) {}

  async snapshotRead<T>(read: (snapshot: NodeExecutionReadSnapshot) => Promise<T>): Promise<T> {
    if (databaseTransactionIsActive(this.db)) return read(this)
    return databaseSessionFor(this.db).snapshotRead((tx) =>
      read(new DrizzleNodeExecutionPersistence(tx, this.content)),
    )
  }

  async read(nodeRunId: string): Promise<NodeExecutionSnapshot | null> {
    const { nodeRuns } = tablesOf(this.db)
    const [row] = await this.db
      .select({ recordMode: nodeRuns.recordMode })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return row?.recordMode === 'executable'
      ? readNodeRunSnapshot(this.db, nodeRunId, this.content)
      : null
  }

  async list(input: NodeExecutionQuery): Promise<readonly NodeExecutionSnapshot[]> {
    const load = async (tx: PersistenceDb) => {
      const { nodeRuns, nodeRunRuntimeStates } = tablesOf(tx)
      const rows = await tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .leftJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
        .where(whereQuery(tx, input))
        .orderBy(asc(nodeRuns.seq))
      const history =
        input.excludeSuperseded === true
          ? await createRunSelectionReader(tx).familyHistory(
              input.taskId,
              {
                ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
                ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
              },
              { excludeSuperseded: true },
            )
          : null
      const allowed = history === null ? null : new Set(history.map((row) => row.id))
      const snapshots: NodeExecutionSnapshot[] = []
      const ids = rows.filter((row) => allowed === null || allowed.has(row.id)).map((row) => row.id)
      const byId = new Map<string, Awaited<ReturnType<typeof readNodeRunRows>>[number]>()
      for (let offset = 0; offset < ids.length; offset += 400) {
        for (const row of await readNodeRunRows(tx, {
          runIds: ids.slice(offset, offset + 400),
          executableOnly: true,
        }))
          byId.set(row.run.id, row)
      }
      for (const id of ids) {
        const row = byId.get(id)
        if (!row) continue
        const facts = await projectNodeRunFacts(row, this.content)
        snapshots.push(projectNodeRunSnapshot(row, facts.promptText))
      }
      return snapshots
    }
    return databaseTransactionIsActive(this.db)
      ? load(this.db)
      : databaseSessionFor(this.db).snapshotRead(load)
  }

  async listOutputs(nodeRunId: string) {
    const { nodeRunOutputs } = tablesOf(this.db)
    const rows = await this.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
      .orderBy(asc(nodeRunOutputs.portName))
    return Promise.all(
      rows.map(async ({ contentRefJson, contentInlineBytes, ...row }) => ({
        ...row,
        content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
          await this.content.read(contentRefColumns.decode(contentRefJson, contentInlineBytes)!),
        ),
      })),
    )
  }

  async countAgentTextEvents(nodeRunId: string, frameworkPrefix: string): Promise<number> {
    const { nodeRunEvents } = tablesOf(this.db)
    const rows = await this.db
      .select({ count: count() })
      .from(nodeRunEvents)
      .where(
        and(
          eq(nodeRunEvents.nodeRunId, nodeRunId),
          eq(nodeRunEvents.kind, 'text'),
          notLike(nodeRunEvents.payload, `${frameworkPrefix}%`),
        ),
      )
      .limit(1)
    return Number(rows[0]?.count ?? 0)
  }

  async readStderr(nodeRunId: string): Promise<string> {
    const { nodeRunEvents } = tablesOf(this.db)
    const rows = await this.db
      .select({ payload: nodeRunEvents.payload })
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'stderr')))
      .orderBy(asc(nodeRunEvents.id))
    return rows.map((row) => row.payload).join('\n')
  }

  async patch(input: Parameters<NodeExecutionPersistence['patch']>[0]): Promise<boolean> {
    const config = input.values.config
    const promptRequested = config?.promptText !== undefined || config?.promptPath !== undefined
    const promptBytes = !promptRequested
      ? undefined
      : config?.promptText != null
        ? new TextEncoder().encode(config.promptText)
        : null
    return withTaskExecutionWrite(this.db, async (tx) => {
      const taskId = await fencedTaskId(
        tx,
        input.nodeRunId,
        input.executionContext,
        input.now ?? Date.now(),
      )
      if (taskId === null) return false
      if (promptRequested) {
        const { nodeRunConfigs } = tablesOf(tx)
        const previous = await tx
          .select({
            contentRefJson: nodeRunConfigs.promptRefJson,
            contentInlineBytes: nodeRunConfigs.promptInlineBytes,
          })
          .from(nodeRunConfigs)
          .where(eq(nodeRunConfigs.nodeRunId, input.nodeRunId))
        await releaseContentRowsInTx(tx, 'node-run-prompt', previous, input.now ?? Date.now())
      }
      const prompt =
        promptBytes === undefined
          ? undefined
          : promptBytes === null
            ? null
            : await databaseContentColumnsInTx(
                tx,
                'node-run-prompt',
                JSON.stringify([input.nodeRunId, ulid()]),
                promptBytes,
                taskId,
              )
      await writeNodeRunProjectionInTx(
        tx,
        input.nodeRunId,
        input.values,
        promptRequested && config?.promptText == null && config?.promptPath != null
          ? decodePrompt({ promptText: null, promptPath: config.promptPath })
          : prompt === undefined || prompt === null
            ? prompt
            : contentRefColumns.decode(prompt.contentRefJson, prompt.contentInlineBytes),
      )
      if (input.selection !== undefined) {
        const selection = input.selection
        const expectedRevision =
          selection.expectedRevision === 'current'
            ? await createRunSelectionReader(tx).revision(selection.taskId, selection.slot)
            : selection.expectedRevision
        await createRunSelectionParticipantInTx().apply(tx, [{ ...selection, expectedRevision }])
      }
      return true
    })
  }

  async upsertOutputs(
    input: Parameters<NodeExecutionPersistence['upsertOutputs']>[0],
  ): Promise<void> {
    if (input.outputs.length === 0) return
    await withTaskExecutionWrite(this.db, async (tx) => {
      const taskId = await fencedTaskId(
        tx,
        input.nodeRunId,
        input.executionContext,
        input.now ?? Date.now(),
      )
      if (taskId === null) return
      // RFC-359 W6-T25 —— 端口逐行 upsert 改按批。`set` 走 `excluded.*` 而不是逐行字面量：
      // 一条语句里每行要更新成**自己那行**的值，只有 excluded 伪表能表达（两个引擎同一关键字）。
      // 同批重复端口名先按「后写覆盖先写」压平——逐行写本来就是这个语义，而 PG 对同一冲突行在
      // 一条语句里被改两次会直接抛。
      const rows = []
      for (const output of lastPerKey(input.outputs, (output) => output.portName)) {
        const { nodeRunOutputs } = tablesOf(tx)
        const previous = await tx
          .select()
          .from(nodeRunOutputs)
          .where(
            and(
              eq(nodeRunOutputs.nodeRunId, input.nodeRunId),
              eq(nodeRunOutputs.portName, output.portName),
            ),
          )
        await releaseContentRowsInTx(tx, 'node-run-output', previous, input.now ?? Date.now())
        rows.push({
          nodeRunId: input.nodeRunId,
          portName: output.portName,
          ...(await databaseContentColumnsInTx(
            tx,
            'node-run-output',
            JSON.stringify([input.nodeRunId, output.portName, ulid()]),
            new TextEncoder().encode(output.content),
            taskId,
          )),
          kind: output.kind ?? null,
          archiveJson: output.archiveJson ?? null,
          active: output.active ?? true,
        })
      }
      const { nodeRunOutputs } = tablesOf(tx)
      await insertInBatches(tx, nodeRunOutputs, rows, (batch) => {
        return queryWrite(
          tx
            .insert(nodeRunOutputs)
            .values([...batch])
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: {
                contentRefJson: sql`excluded.${sql.identifier(nodeRunOutputs.contentRefJson.name)}`,
                contentInlineBytes: sql`excluded.${sql.identifier(nodeRunOutputs.contentInlineBytes.name)}`,
                kind: sql`excluded.${sql.identifier(nodeRunOutputs.kind.name)}`,
                archiveJson: sql`excluded.${sql.identifier(nodeRunOutputs.archiveJson.name)}`,
                active: sql`excluded.${sql.identifier(nodeRunOutputs.active.name)}`,
              },
            }),
        )
      })
    })
  }

  async replaceOutputs(
    input: Parameters<NodeExecutionPersistence['replaceOutputs']>[0],
  ): Promise<void> {
    await withTaskExecutionWrite(this.db, async (tx) => {
      const taskId = await fencedTaskId(
        tx,
        input.nodeRunId,
        input.executionContext,
        input.now ?? Date.now(),
      )
      if (taskId === null) return
      const { nodeRunOutputs } = tablesOf(tx)
      const previous = await tx
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, input.nodeRunId))
      await releaseContentRowsInTx(tx, 'node-run-output', previous, input.now ?? Date.now())
      await tx.delete(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, input.nodeRunId))
      for (const output of input.outputs) {
        await tx.insert(nodeRunOutputs).values({
          nodeRunId: input.nodeRunId,
          portName: output.portName,
          ...(await databaseContentColumnsInTx(
            tx,
            'node-run-output',
            JSON.stringify([input.nodeRunId, output.portName, ulid()]),
            new TextEncoder().encode(output.content),
            taskId,
          )),
          kind: output.kind ?? null,
          archiveJson: output.archiveJson ?? null,
          active: output.active ?? true,
        })
      }
    })
  }

  async appendEvent(input: Parameters<NodeExecutionPersistence['appendEvent']>[0]): Promise<void> {
    await this.appendEvents({
      nodeRunId: input.nodeRunId,
      events: [input],
      ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    })
  }

  async appendEvents(
    input: Parameters<NodeExecutionPersistence['appendEvents']>[0],
  ): Promise<void> {
    if (input.events.length === 0) return
    await withTaskExecutionWrite(this.db, async (tx) => {
      const taskId = await fencedTaskId(
        tx,
        input.nodeRunId,
        input.executionContext,
        input.events.at(-1)?.ts ?? Date.now(),
      )
      if (taskId === null) return
      // RFC-359 W6-T25 —— 事件按批落库。切批在同一笔事务里，原子性不变；行数上限由能力矩阵
      // 给（`batchInsertMax(列数)`），调用方不再自带一份「多少行一批」的推导。
      const fresh = []
      for (const event of input.events) {
        if (event.sourceKey !== undefined) {
          const { nodeExecutionEventSources } = tablesOf(tx)
          const inserted = await tx
            .insert(nodeExecutionEventSources)
            .values({
              sourceKey: event.sourceKey,
              nodeRunId: input.nodeRunId,
            })
            .onConflictDoNothing()
            .returning({ sourceKey: nodeExecutionEventSources.sourceKey })
          if (inserted.length === 0) continue
        }
        fresh.push(event)
      }
      const { nodeRunEvents } = tablesOf(tx)
      await insertInBatches(
        tx,
        nodeRunEvents,
        fresh.map((event) => ({
          nodeRunId: input.nodeRunId,
          ts: event.ts,
          kind: event.kind,
          payload: event.payload,
          sessionId: event.sessionId ?? null,
          parentSessionId: event.parentSessionId ?? null,
        })),
        (batch) => {
          return queryWrite(tx.insert(nodeRunEvents).values([...batch]))
        },
      )
    })
  }

  async retagSessionEpochs(
    input: Parameters<NodeExecutionPersistence['retagSessionEpochs']>[0],
  ): Promise<void> {
    if (input.supersededSessionIds.length === 0) return
    await withTaskExecutionWrite(this.db, async (tx) => {
      const taskId = await fencedTaskId(
        tx,
        input.nodeRunId,
        input.executionContext,
        input.now ?? Date.now(),
      )
      if (taskId === null) return
      const { nodeRunEvents } = tablesOf(tx)
      await tx
        .update(nodeRunEvents)
        .set({ sessionId: input.logicalSessionId })
        .where(
          and(
            eq(nodeRunEvents.nodeRunId, input.nodeRunId),
            inArray(nodeRunEvents.sessionId, input.supersededSessionIds),
            isNull(nodeRunEvents.parentSessionId),
          ),
        )
      await tx
        .update(nodeRunEvents)
        .set({ parentSessionId: input.logicalSessionId })
        .where(
          and(
            eq(nodeRunEvents.nodeRunId, input.nodeRunId),
            inArray(nodeRunEvents.parentSessionId, input.supersededSessionIds),
          ),
        )
    })
  }
}

/** Caller holds owner fence and Task root. Preserve unspecified output metadata on replacement. */
export async function writeNodeRunOutputInTx(
  tx: PersistenceTx,
  nodeRunId: string,
  output: {
    readonly portName: string
    readonly content: string
    readonly kind?: string | null
    readonly archiveJson?: string | null
    readonly active?: boolean
  },
  now = Date.now(),
): Promise<void> {
  const { nodeRuns, nodeRunOutputs } = tablesOf(tx)
  const [run] = await tx
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  if (!run) throw new Error('node-run-output-owner-missing')
  const previous = await tx
    .select()
    .from(nodeRunOutputs)
    .where(
      and(eq(nodeRunOutputs.nodeRunId, nodeRunId), eq(nodeRunOutputs.portName, output.portName)),
    )
  await releaseContentRowsInTx(tx, 'node-run-output', previous, now)
  const { content, ...metadata } = output
  const columns = await databaseContentColumnsInTx(
    tx,
    'node-run-output',
    JSON.stringify([nodeRunId, output.portName, ulid()]),
    new TextEncoder().encode(content),
    run.taskId,
  )
  await tx
    .insert(nodeRunOutputs)
    .values({ nodeRunId, ...metadata, ...columns })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: { ...metadata, ...columns },
    })
}
