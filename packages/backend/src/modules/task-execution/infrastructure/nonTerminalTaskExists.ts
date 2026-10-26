import { tablesOf } from '@/platform/persistence/sessionTables'
// RFC-395 II-b O3 / plan §6.13: accepted same-statement fragment for webhook retention.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'

export function nonTerminalTaskExists(db: PersistenceDb, taskIdColumn: AnyColumn): SQL {
  const { tasks } = tablesOf(db)
  return sql`EXISTS (
    SELECT 1 FROM ${tasks}
    WHERE ${tasks.id} = ${taskIdColumn}
      AND ${tasks.status} NOT IN (${sql.join(
        TERMINAL_TASK_STATUSES.map((value) => sql`${value}`),
        sql`, `,
      )})
  )`
}
