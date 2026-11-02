// RFC-414 — the two single-row task reads composition used to issue inline: the hosted workspace owner lookup
// (crewstationExecution; since RFC-417 crewstation/executionWorkspaces) and the status reads of hosted recovery and the
// action runners (one query, formerly copied in both). Columns, conditions and limits are unchanged.
import type { TaskStatus } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskReadColumns } from './taskRepositorySql'

/** The task's `worktree_path` (its workspace reference), or undefined when the row is absent. */
export async function readTaskWorkspaceRef(
  db: PersistenceDb,
  taskId: string,
): Promise<string | undefined> {
  const { tasks } = tablesOf(db)
  const task = (
    await db
      .select({ workspaceRef: taskReadColumns(db).worktreePath })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  return task?.workspaceRef
}

/** The task's status, or null when the row is absent. */
export async function readTaskStatus(
  db: PersistenceDb,
  taskId: string,
): Promise<TaskStatus | null> {
  const { tasks } = tablesOf(db)
  const row = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  )[0]
  return row?.status ?? null
}
