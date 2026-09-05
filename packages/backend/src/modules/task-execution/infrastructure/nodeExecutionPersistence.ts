// RFC-359 W4-B1 批 2f —— node run 执行投影（快照 / 输出 / 事件）：一份实现，两个 provider 共用。
// 写路径是产品里最热的（agent 每吐一行就 appendEvents 一次）：统一写事务 + owner 围栏 + 聚合根行锁。

import { and, asc, count, eq, inArray, isNotNull, isNull, notLike } from 'drizzle-orm'

import { nodeRunEvents, nodeRunOutputs, nodeRuns } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { MERGE_STATES, RerunCauseSchema, type MergeStateOrNull } from '@agent-workflow/shared'
import type {
  NodeExecutionPersistence,
  NodeExecutionQuery,
  NodeExecutionSnapshot,
} from '../application/ports/nodeExecutionPersistence'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import {
  fenceTaskWrite,
  type TaskExecutionTransaction,
  withTaskExecutionWrite,
} from './ownedTaskExecution'

function whereQuery(input: NodeExecutionQuery) {
  const conditions = [eq(nodeRuns.taskId, input.taskId)]
  if (input.nodeId !== undefined) conditions.push(eq(nodeRuns.nodeId, input.nodeId))
  if (input.iteration !== undefined) conditions.push(eq(nodeRuns.iteration, input.iteration))
  if (input.status !== undefined) conditions.push(eq(nodeRuns.status, input.status))
  if (input.mergeState === null) conditions.push(isNull(nodeRuns.mergeState))
  else if (input.mergeState !== undefined) {
    conditions.push(eq(nodeRuns.mergeState, input.mergeState))
  }
  if (input.childOnly === true) conditions.push(isNotNull(nodeRuns.parentNodeRunId))
  if (input.parentNodeRunId === null) conditions.push(isNull(nodeRuns.parentNodeRunId))
  else if (input.parentNodeRunId !== undefined) {
    conditions.push(eq(nodeRuns.parentNodeRunId, input.parentNodeRunId))
  }
  // RFC-354 — one frame: null = the top scope, a run id = that wrapper generation's body.
  if (input.containerRunId === null) conditions.push(isNull(nodeRuns.containerRunId))
  else if (input.containerRunId !== undefined) {
    conditions.push(eq(nodeRuns.containerRunId, input.containerRunId))
  }
  return and(...conditions)
}

type NodeRunRow = typeof nodeRuns.$inferSelect

function mergeStateOf(value: string | null): MergeStateOrNull {
  if (value === null || (MERGE_STATES as readonly string[]).includes(value)) {
    return value as MergeStateOrNull
  }
  throw new Error(`invalid persisted node merge state '${value}'`)
}

function snapshotOf(row: NodeRunRow): NodeExecutionSnapshot {
  return {
    ...row,
    mergeState: mergeStateOf(row.mergeState),
    rerunCause: row.rerunCause === null ? null : RerunCauseSchema.parse(row.rerunCause),
  }
}

async function fencedTaskId(
  tx: TaskExecutionTransaction,
  nodeRunId: string,
  context: TaskExecutionContextRef | undefined,
  now: number,
): Promise<string | null> {
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
  await engineOf(tx).lockAggregateRoot(tx, nodeRuns, nodeRuns.id, nodeRunId)
  return taskId
}

export class DrizzleNodeExecutionPersistence implements NodeExecutionPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async read(nodeRunId: string): Promise<NodeExecutionSnapshot | null> {
    const rows = await this.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
    return rows[0] === undefined ? null : snapshotOf(rows[0])
  }

  async list(input: NodeExecutionQuery): Promise<readonly NodeExecutionSnapshot[]> {
    return (
      await this.db.select().from(nodeRuns).where(whereQuery(input)).orderBy(asc(nodeRuns.id))
    ).map(snapshotOf)
  }

  async listOutputs(nodeRunId: string) {
    return await this.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
      .orderBy(asc(nodeRunOutputs.portName))
  }

  async countAgentTextEvents(nodeRunId: string, frameworkPrefix: string): Promise<number> {
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
    const rows = await this.db
      .select({ payload: nodeRunEvents.payload })
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'stderr')))
      .orderBy(asc(nodeRunEvents.id))
    return rows.map((row) => row.payload).join('\n')
  }

  async patch(input: Parameters<NodeExecutionPersistence['patch']>[0]): Promise<boolean> {
    return await withTaskExecutionWrite(this.db, async (tx) => {
      const taskId = await fencedTaskId(
        tx,
        input.nodeRunId,
        input.executionContext,
        input.now ?? Date.now(),
      )
      if (taskId === null) return false
      const rows = await tx
        .update(nodeRuns)
        .set(input.values)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .returning({ id: nodeRuns.id })
      return rows.length === 1
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
      for (const output of input.outputs) {
        await tx
          .insert(nodeRunOutputs)
          .values({
            nodeRunId: input.nodeRunId,
            portName: output.portName,
            content: output.content,
            kind: output.kind ?? null,
            archiveJson: output.archiveJson ?? null,
            active: output.active ?? true,
          })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: {
              content: output.content,
              kind: output.kind ?? null,
              archiveJson: output.archiveJson ?? null,
              active: output.active ?? true,
            },
          })
          .run()
      }
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
      await tx.delete(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, input.nodeRunId)).run()
      if (input.outputs.length > 0) {
        await tx
          .insert(nodeRunOutputs)
          .values(
            input.outputs.map((output) => ({
              nodeRunId: input.nodeRunId,
              portName: output.portName,
              content: output.content,
              kind: output.kind ?? null,
              archiveJson: output.archiveJson ?? null,
              active: output.active ?? true,
            })),
          )
          .run()
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
        input.events[input.events.length - 1]!.ts,
      )
      if (taskId === null) return
      await tx
        .insert(nodeRunEvents)
        .values(
          input.events.map((event) => ({
            nodeRunId: input.nodeRunId,
            ts: event.ts,
            kind: event.kind,
            payload: event.payload,
            sessionId: event.sessionId ?? null,
            parentSessionId: event.parentSessionId ?? null,
          })),
        )
        .run()
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
        .run()
      await tx
        .update(nodeRunEvents)
        .set({ parentSessionId: input.logicalSessionId })
        .where(
          and(
            eq(nodeRunEvents.nodeRunId, input.nodeRunId),
            inArray(nodeRunEvents.parentSessionId, input.supersededSessionIds),
          ),
        )
        .run()
    })
  }
}
