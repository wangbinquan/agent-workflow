import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  notExists,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm'
import type { TaskGateQueries } from '../application/ports/taskGateQueries'
import { taskVisibilityCondition, visibleTaskIdsFor } from './taskAuthorization'
import {
  taskReadColumns,
  taskWorkflowNameSql,
  type WorkflowNameExpression,
} from './taskRepositorySql'

import { taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

/** 与调用者共用当前会话（包括事务），不另开事务或解释冻结定义。 */
export function createTaskGateQueries(db: PersistenceDb): TaskGateQueries {
  const { tasks } = tablesOf(db)
  const context = {
    id: tasks.id,
    name: tasks.name,
    status: tasks.status,
    ownerUserId: tasks.ownerUserId,
    lifecycleEventRevision: tasks.lifecycleEventRevision,
    sourceTerminationFence: tasks.sourceTerminationFence,
    workflowId: taskReadColumns(db).workflowId,
    subjectKind: taskReadColumns(db).subjectKind,
    sourceId: taskReadColumns(db).sourceId,
    sourceName: taskReadColumns(db).sourceName,
    worktreePath: taskReadColumns(db).worktreePath,
  }
  return {
    visibleTaskIds(subject, taskIds) {
      return visibleTaskIdsFor(db, subject, taskIds)
    },
    async listContexts(taskIds) {
      if (taskIds.length === 0) return []
      return db
        .select(context)
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
    },
    async listDefinitionContexts(taskIds) {
      if (taskIds.length === 0) return []
      return db
        .select({ ...context, workflowSnapshot: taskReadColumns(db).workflowSnapshot })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
    },
    async listDispatchContexts(taskIds) {
      if (taskIds.length === 0) return []
      return db
        .select({
          ...context,
          workflowSnapshot: taskReadColumns(db).workflowSnapshot,
          workgroupId: taskReadColumns(db).workgroupId,
          codeRoundId: taskReadColumns(db).codeRoundId,
          sourceAgentName: taskReadColumns(db).sourceAgentName,
          workgroupConfig: taskWorkgroupConfigSelection(db),
        })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
    },
  }
}

/** The task gate open condition as collaboration's badge read model takes it (RFC-483). */
export type TaskGateOpenCondition = (
  db: PersistenceDb,
  taskId: AnyColumn | SQL,
  includeMissing?: boolean,
  requireSubjectName?: boolean,
) => SQL

/**
 * 同语句的半连接，保留徽标计数的孤儿/终态语义与单次往返。RFC-567：“任务有主体名”那一支要取工作流名，片段由装配根交入
 * （resource-catalog 的实现）——所以这个条件由绑定函数造出，签名与原来的 `taskGateOpenCondition` 相同。
 */
export function bindTaskGateOpenCondition(
  workflowName: WorkflowNameExpression,
): TaskGateOpenCondition {
  return function taskGateOpenCondition(
    db,
    taskId,
    includeMissing = false,
    requireSubjectName = false,
  ) {
    const { tasks } = tablesOf(db)
    const present = db
      .select({ one: sql`1` })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    const open = exists(
      db
        .select({ one: sql`1` })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, taskId),
            notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
            requireSubjectName ? isNotNull(taskGateSubjectName(db, workflowName)) : undefined,
          ),
        ),
    )
    return includeMissing ? or(notExists(present), open)! : open
  }
}

/** RFC-395 II-a: keep subject-name filtering in the badge's single SQL statement. */
function taskGateSubjectName(db: PersistenceDb, workflowName: WorkflowNameExpression): SQL {
  return taskWorkflowNameSql(
    { subjectKind: taskReadColumns(db).subjectKind },
    workflowName(db, taskReadColumns(db).workflowId),
  )
}

export function taskGateVisibleCondition(
  db: PersistenceDb,
  taskId: AnyColumn | SQL,
  viewer: {
    readonly userId: string
    readonly canReadAllTasks: boolean
  },
): SQL {
  const { tasks } = tablesOf(db)
  return exists(
    db
      .select({ one: sql`1` })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), taskVisibilityCondition(db, viewer))),
  )
}
