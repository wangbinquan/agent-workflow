import { and, asc, eq, inArray, isNotNull, isNull, notLike, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns } from '@/db/schema'
import { retrySqliteWrite } from '@/db/sqliteWriteRetry'
import { MERGE_STATES, RerunCauseSchema, type MergeStateOrNull } from '@agent-workflow/shared'
import type {
  NodeExecutionPersistence,
  NodeExecutionQuery,
  NodeExecutionSnapshot,
} from '../application/ports/nodeExecutionPersistence'
import { withTaskExecutionMutation, withTaskExecutionTransaction } from './sqliteOwnedTaskMutation'

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

export class SqliteNodeExecutionPersistence implements NodeExecutionPersistence {
  constructor(private readonly db: DbClient) {}

  async read(nodeRunId: string): Promise<NodeExecutionSnapshot | null> {
    const row = this.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()
    return row === undefined ? null : snapshotOf(row)
  }

  async list(input: NodeExecutionQuery): Promise<readonly NodeExecutionSnapshot[]> {
    return this.db
      .select()
      .from(nodeRuns)
      .where(whereQuery(input))
      .orderBy(asc(nodeRuns.id))
      .all()
      .map(snapshotOf)
  }

  async listOutputs(nodeRunId: string) {
    return this.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
      .orderBy(asc(nodeRunOutputs.portName))
      .all()
  }

  async countAgentTextEvents(nodeRunId: string, frameworkPrefix: string): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(nodeRunEvents)
      .where(
        and(
          eq(nodeRunEvents.nodeRunId, nodeRunId),
          eq(nodeRunEvents.kind, 'text'),
          notLike(nodeRunEvents.payload, `${frameworkPrefix}%`),
        ),
      )
      .get()
    return Number(row?.count ?? 0)
  }

  async readStderr(nodeRunId: string): Promise<string> {
    return this.db
      .select({ payload: nodeRunEvents.payload })
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'stderr')))
      .orderBy(asc(nodeRunEvents.id))
      .all()
      .map((row) => row.payload)
      .join('\n')
  }

  async patch(input: Parameters<NodeExecutionPersistence['patch']>[0]): Promise<boolean> {
    const taskId = this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()?.taskId
    if (taskId === undefined) return false
    let changed = false
    withTaskExecutionMutation({
      db: this.db,
      taskId,
      ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
      ...(input.now === undefined ? {} : { now: input.now }),
      run: (tx) => {
        changed =
          tx
            .update(nodeRuns)
            .set(input.values)
            .where(eq(nodeRuns.id, input.nodeRunId))
            .returning({ id: nodeRuns.id })
            .get() !== undefined
      },
    })
    return changed
  }

  async upsertOutputs(
    input: Parameters<NodeExecutionPersistence['upsertOutputs']>[0],
  ): Promise<void> {
    if (input.outputs.length === 0) return
    const row = this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()
    if (row === undefined) return
    withTaskExecutionTransaction({
      db: this.db,
      taskId: row.taskId,
      ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
      ...(input.now === undefined ? {} : { now: input.now }),
      run: (tx) => {
        for (const output of input.outputs) {
          tx.insert(nodeRunOutputs)
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
      },
    })
  }

  async replaceOutputs(
    input: Parameters<NodeExecutionPersistence['replaceOutputs']>[0],
  ): Promise<void> {
    const row = this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()
    if (row === undefined) return
    withTaskExecutionTransaction({
      db: this.db,
      taskId: row.taskId,
      ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
      ...(input.now === undefined ? {} : { now: input.now }),
      run: (tx) => {
        tx.delete(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, input.nodeRunId)).run()
        if (input.outputs.length > 0) {
          tx.insert(nodeRunOutputs)
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
      },
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
    const row = this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()
    if (row === undefined) return
    await retrySqliteWrite(() =>
      withTaskExecutionMutation({
        db: this.db,
        taskId: row.taskId,
        ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
        now: input.events[input.events.length - 1]!.ts,
        run: (tx) => {
          tx.insert(nodeRunEvents)
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
        },
      }),
    )
  }

  async retagSessionEpochs(
    input: Parameters<NodeExecutionPersistence['retagSessionEpochs']>[0],
  ): Promise<void> {
    if (input.supersededSessionIds.length === 0) return
    const row = this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()
    if (row === undefined) return
    withTaskExecutionTransaction({
      db: this.db,
      taskId: row.taskId,
      ...(input.executionContext === undefined ? {} : { context: input.executionContext }),
      ...(input.now === undefined ? {} : { now: input.now }),
      run: (tx) => {
        tx.update(nodeRunEvents)
          .set({ sessionId: input.logicalSessionId })
          .where(
            and(
              eq(nodeRunEvents.nodeRunId, input.nodeRunId),
              inArray(nodeRunEvents.sessionId, input.supersededSessionIds),
              isNull(nodeRunEvents.parentSessionId),
            ),
          )
          .run()
        tx.update(nodeRunEvents)
          .set({ parentSessionId: input.logicalSessionId })
          .where(
            and(
              eq(nodeRunEvents.nodeRunId, input.nodeRunId),
              inArray(nodeRunEvents.parentSessionId, input.supersededSessionIds),
            ),
          )
          .run()
      },
    })
  }
}
