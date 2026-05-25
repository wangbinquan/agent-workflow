// RFC-061 follow-up — diagnose panel data source.
//
// Replaces RFC-057's diagnose endpoint with a projection-native
// aggregator. Given a task id, returns everything an operator needs to
// assess + recover a stuck or wedged task:
//
//   - taskSummary       status, age, last event ts
//   - openSuspensions   every open suspension on the task, with body
//   - pendingLogicalRuns logical_runs in non-terminal status
//   - openAlerts        lifecycle_alerts rows still open (S5/S6 etc.)
//
// No recovery actions yet — the legacy /api/.../apply-repair lifted off
// the deleted lifecycleRepair tree and the projection-native repair
// catalog is a follow-up PR. Until then, the page renders read-only
// observability and the only manual recovery is "cancel + relaunch".

import { and, asc, eq, inArray, isNull, max as sqlMax, ne } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  events as eventsTable,
  lifecycleAlerts,
  logicalRuns,
  suspensions,
  tasks,
} from '@/db/schema'
import { NotFoundError } from '@/util/errors'
import type { LifecycleAlertRule, LifecycleAlertSeverity, SignalKind } from '@agent-workflow/shared'

export interface DiagnoseTaskSummary {
  taskId: string
  status: string
  startedAt: number
  finishedAt: number | null
  lastEventTs: number | null
  errorSummary: string | null
}

export interface DiagnoseSuspensionEntry {
  id: string
  signalKind: SignalKind
  awaitsActor: string
  body: unknown
  createdAt: number
  nodeId: string
  iter: number
}

export interface DiagnoseLogicalRunEntry {
  id: string
  nodeId: string
  loopIter: number
  shardKey: string
  iter: number
  status: string
  updatedAt: number
}

export interface DiagnoseAlertEntry {
  id: string
  rule: LifecycleAlertRule
  severity: LifecycleAlertSeverity
  detail: unknown
  detectedAt: number
}

export interface DiagnoseTaskResponse {
  task: DiagnoseTaskSummary
  openSuspensions: DiagnoseSuspensionEntry[]
  pendingLogicalRuns: DiagnoseLogicalRunEntry[]
  openAlerts: DiagnoseAlertEntry[]
}

export async function diagnoseTask(db: DbClient, taskId: string): Promise<DiagnoseTaskResponse> {
  const taskRows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      startedAt: tasks.startedAt,
      finishedAt: tasks.finishedAt,
      errorSummary: tasks.errorSummary,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const t = taskRows[0]
  if (t === undefined) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  const tsRows = await db
    .select({ maxTs: sqlMax(eventsTable.ts) })
    .from(eventsTable)
    .where(eq(eventsTable.taskId, taskId))
  const lastEventTs = tsRows[0]?.maxTs ?? null

  const suspRows = await db
    .select({
      id: suspensions.id,
      signalKind: suspensions.signalKind,
      awaitsActor: suspensions.awaitsActor,
      payload: suspensions.payload,
      createdAt: suspensions.createdAt,
      lrNodeId: logicalRuns.nodeId,
      lrIter: logicalRuns.iter,
    })
    .from(suspensions)
    .innerJoin(logicalRuns, eq(suspensions.logicalRunId, logicalRuns.id))
    .where(and(eq(logicalRuns.taskId, taskId), isNull(suspensions.resolvedAt)))
    .orderBy(asc(suspensions.createdAt))
  const openSuspensions: DiagnoseSuspensionEntry[] = suspRows.map((r) => ({
    id: r.id,
    signalKind: r.signalKind as SignalKind,
    awaitsActor: r.awaitsActor,
    body: safeJson(r.payload),
    createdAt: r.createdAt,
    nodeId: r.lrNodeId,
    iter: r.lrIter,
  }))

  const lrRows = await db
    .select({
      id: logicalRuns.id,
      nodeId: logicalRuns.nodeId,
      loopIter: logicalRuns.loopIter,
      shardKey: logicalRuns.shardKey,
      iter: logicalRuns.iter,
      status: logicalRuns.status,
      updatedAt: logicalRuns.updatedAt,
    })
    .from(logicalRuns)
    .where(
      and(
        eq(logicalRuns.taskId, taskId),
        inArray(logicalRuns.status, ['pending', 'running', 'suspended']),
        ne(logicalRuns.status, 'done'),
      ),
    )
    .orderBy(asc(logicalRuns.updatedAt))
  const pendingLogicalRuns: DiagnoseLogicalRunEntry[] = lrRows.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    loopIter: r.loopIter,
    shardKey: r.shardKey,
    iter: r.iter,
    status: r.status,
    updatedAt: r.updatedAt,
  }))

  const alertRows = await db
    .select({
      id: lifecycleAlerts.id,
      rule: lifecycleAlerts.rule,
      severity: lifecycleAlerts.severity,
      detail: lifecycleAlerts.detail,
      detectedAt: lifecycleAlerts.detectedAt,
    })
    .from(lifecycleAlerts)
    .where(and(eq(lifecycleAlerts.taskId, taskId), isNull(lifecycleAlerts.resolvedAt)))
    .orderBy(asc(lifecycleAlerts.detectedAt))
  const openAlerts: DiagnoseAlertEntry[] = alertRows.map((r) => ({
    id: r.id,
    rule: r.rule as LifecycleAlertRule,
    severity: r.severity as LifecycleAlertSeverity,
    detail: safeJson(r.detail),
    detectedAt: r.detectedAt,
  }))

  return {
    task: {
      taskId: t.id,
      status: t.status,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      lastEventTs,
      errorSummary: t.errorSummary,
    },
    openSuspensions,
    pendingLogicalRuns,
    openAlerts,
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
