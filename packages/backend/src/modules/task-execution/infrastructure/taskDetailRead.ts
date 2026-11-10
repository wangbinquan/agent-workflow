// RFC-478 —— 任务详情的读侧投影（原 `services/task.ts`）：`getTask` 与批量的 `loadTaskFailureCodes`。函数体原样迁来。
import type { FailureCode, Task } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createRunHistoryBatchSnapshot } from '../application/runHistory'
import { projectWorkflowSnapshotForRead } from '../domain/builtinWorkflowLayout'
import { createNodeRunQueries } from './nodeRunQueries'
import { createTaskDetailQueries } from './taskDetailQueries'

export async function getTask(db: PersistenceDb, id: string): Promise<Task | null> {
  const detail = await createTaskDetailQueries(db).read(id)
  if (detail === null) return null
  const task = {
    ...detail.task,
    workflowSnapshot: projectWorkflowSnapshotForRead(
      detail.task.workflowSnapshot,
      detail.definitionOrigin === 'platform',
    ),
  }
  const codes = await loadTaskFailureCodes(db, [
    { id: task.id, status: task.status, failedNodeId: task.failedNodeId },
  ])
  const failureCode = codes.get(task.id)
  return failureCode !== undefined ? { ...task, failureCode } : task
}

/**
 * RFC-203 T4 — deterministic failed-run oracle: for failed tasks, project the
 * RFC-145 failure code of the FAILED NODE's freshest top-level run into the
 * task-level DTO (Task / TaskSummary.failureCode) so the list page and the
 * failure banner can localize copy without fetching node runs. One batched
 * query for any number of tasks; tasks without failedNodeId (scheduler-level
 * failures) resolve to null.
 */
/**
 * RFC-357：参数类型放宽到两个 provider 的公共基类型。函数体只有一次 drizzle 批量查询
 * 加一次纯函数挑选（`pickFreshestRun`），本就与 provider 无关；放宽之后 PostgreSQL 的
 * 列表页可以直接复用它，不必再像 `postgresqlTaskRouteOperations.failedCode` 那样逐行发
 * 一次查询（那是本 RFC 要消灭的 N+1 之一）。`DbClient` 仍可赋值给它，既有调用点零改动。
 */
export async function loadTaskFailureCodes(
  db: PersistenceDb,
  rows: ReadonlyArray<{ id: string; status: string; failedNodeId: string | null }>,
): Promise<Map<string, FailureCode | null>> {
  const out = new Map<string, FailureCode | null>()
  const wanted = rows.filter((r) => r.status === 'failed' && r.failedNodeId !== null)
  if (wanted.length === 0) return out
  const runRows = await createNodeRunQueries(db).listHistoryFields(
    { taskIds: wanted.map((r) => r.id) },
    ['taskId', 'nodeId', 'id', 'seq', 'parentNodeRunId', 'status', 'failureCode'],
  )
  const snapshot = createRunHistoryBatchSnapshot(runRows)
  const runsById = new Map(runRows.map((row) => [row.id, row]))
  for (const t of wanted) {
    const selected = (
      await snapshot.familyHistory(t.id, { nodeId: t.failedNodeId! }, { topLevelOnly: true })
    ).at(-1)
    const fresh = selected === undefined ? undefined : runsById.get(selected.id)
    out.set(t.id, (fresh?.failureCode ?? null) as FailureCode | null)
  }
  return out
}
