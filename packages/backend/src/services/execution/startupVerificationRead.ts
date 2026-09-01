// RFC-280 T3 — read end for node_runs.startup_verification_json.
// GET /api/tasks/:id/node-runs/:nodeRunId/startup-verification 的 service 层。
// 与 inventory 的 read end 同一错误契约（404 task / node-run not found）；
// NULL / 解析失败 → { available: false }（该 run 早于验证层、无声明注入、或
// 写入损坏——UI 一律显示「无验证数据」，绝不猜测）。

import {
  StartupVerificationRecordSchema,
  type StartupVerificationResponse,
} from '@agent-workflow/shared'
import type { TaskStartupVerificationReadModel } from '@/modules/task-execution/public/types'
import { createSqliteTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels'
import { NotFoundError } from '@/util/errors'

export async function getStartupVerification(
  source:
    | TaskStartupVerificationReadModel
    | Parameters<typeof createSqliteTaskExecutionReadModels>[0],
  taskId: string,
  nodeRunId: string,
): Promise<StartupVerificationResponse> {
  const reader =
    'find' in source ? source : createSqliteTaskExecutionReadModels(source).startupVerification
  const snapshot = await reader.find(taskId, nodeRunId)
  if (!snapshot.taskExists) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const run = snapshot.nodeRun
  if (run === null || run.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
  if (run.startupVerificationJson === null || run.startupVerificationJson === '') {
    return { available: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(run.startupVerificationJson)
  } catch {
    return { available: false }
  }
  const record = StartupVerificationRecordSchema.safeParse(parsed)
  if (!record.success) return { available: false }
  return { available: true, record: record.data }
}
