// RFC-061 follow-up — projection-native wire bundle for the canvas /
// detail / timeline rebuild. Replaces the synthesised NodeRun shape
// served by services/taskRunsProjection.ts with the raw projection
// tables (logical_runs / attempts / node_outputs / suspensions), so
// new components can render without going through the legacy shim.
//
// The shim stays in place for the existing canvas; this endpoint is
// the path forward for any new wire.

import { eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  attempts as attemptsTable,
  logicalRuns,
  nodeOutputs,
  suspensions,
  tasks,
} from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import type {
  AttemptWire,
  LogicalRunWire,
  NodeOutputWire,
  SuspensionWire,
  TaskProjectionView,
} from '@agent-workflow/shared'

export async function getTaskProjectionView(
  db: DbClient,
  taskId: string,
): Promise<TaskProjectionView> {
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (taskRows.length === 0) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  const lrRows = await db.select().from(logicalRuns).where(eq(logicalRuns.taskId, taskId))
  const lrIds = lrRows.map((r) => r.id)

  const attRows =
    lrIds.length === 0
      ? []
      : await db.select().from(attemptsTable).where(inArray(attemptsTable.logicalRunId, lrIds))

  const outRows = await db.select().from(nodeOutputs).where(eq(nodeOutputs.taskId, taskId))

  const suspRows =
    lrIds.length === 0
      ? []
      : await db.select().from(suspensions).where(inArray(suspensions.logicalRunId, lrIds))

  const logicalRunsWire: LogicalRunWire[] = lrRows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    nodeId: r.nodeId,
    loopIter: r.loopIter,
    shardKey: r.shardKey,
    iter: r.iter,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastEventId: r.lastEventId,
  }))
  const attemptsWire: AttemptWire[] = attRows.map((a) => ({
    id: a.id,
    logicalRunId: a.logicalRunId,
    attemptSeq: a.attemptSeq,
    pid: a.pid,
    opencodeSessionId: a.opencodeSessionId,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    outcome: a.outcome,
    exitCode: a.exitCode,
    errorMessage: a.errorMessage,
    preSnapshot: a.preSnapshot,
  }))
  const outputsWire: NodeOutputWire[] = outRows.map((o) => ({
    taskId: o.taskId,
    nodeId: o.nodeId,
    loopIter: o.loopIter,
    shardKey: o.shardKey,
    iter: o.iter,
    portName: o.portName,
    content: o.content,
    capturedAt: o.capturedAt,
    sourceEventId: o.sourceEventId,
  }))
  const suspensionsWire: SuspensionWire[] = suspRows.map((s) => ({
    id: s.id,
    logicalRunId: s.logicalRunId,
    signalKind: s.signalKind,
    awaitsActor: s.awaitsActor,
    payload: s.payload,
    createdAt: s.createdAt,
    resolvedAt: s.resolvedAt,
    resolvedByEventId: s.resolvedByEventId,
  }))

  return {
    logicalRuns: logicalRunsWire,
    attempts: attemptsWire,
    outputs: outputsWire,
    suspensions: suspensionsWire,
  }
}
