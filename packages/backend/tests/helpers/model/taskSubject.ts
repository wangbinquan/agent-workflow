// RFC-395 II-a A2: SQL subject oracle stays behind the fixture storage boundary.
import { sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  nonViewCondition,
  parseTaskOperationsQuery,
} from '@/modules/task-execution/infrastructure/taskListPage/filters'
import {
  taskSubjectKindSql,
  taskSubjectSqlColumns,
} from '@/modules/task-execution/infrastructure/taskSubjectSql'

export async function readTaskSubjectSqlFixtures(db: PersistenceDb) {
  return rawRows<{ id: string; kind: string }>(
    db,
    sql`SELECT t.id, ${taskSubjectKindSql(taskSubjectSqlColumns('t'))} AS kind FROM tasks t`,
  )
}

/** The former-wiring workgroup query keeps its shape while projecting the new subject inputs. */
export function taskSubjectFixtureColumns(db: object) {
  const { tasks } = tablesOf(db)
  return {
    workflowId: tasks.workflowId,
    codeRoundId: tasks.codeRoundId,
    sourceAgentId: tasks.sourceAgentId,
    sourceAgentName: tasks.sourceAgentName,
  }
}

/** Existing three-facet API folds generated employee and code-round subjects into workflow. */
export async function readTaskSubjectFacetFixtures(
  db: PersistenceDb,
  subject: 'workflow' | 'agent' | 'workgroup',
) {
  const viewer = { userId: 'viewer', canReadAllTasks: true }
  const parsed = parseTaskOperationsQuery(viewer, { subject, scope: 'all' })
  return rawRows<{ id: string }>(
    db,
    sql`SELECT t.id FROM tasks t WHERE ${nonViewCondition(db, viewer, parsed.filters, 't')}`,
  )
}
