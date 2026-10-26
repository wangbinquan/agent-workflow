import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { and, eq, notInArray } from 'drizzle-orm'
import type { SubjectTaskReferences } from '../application/ports/subjectTaskReferences'
import { taskReadColumns } from './taskRepositorySql'

export function createSubjectTaskReferences(tx: PersistenceTx): SubjectTaskReferences {
  return {
    async nonTerminalTaskIds(subject) {
      const { tasks } = tablesOf(tx)
      const column =
        subject.kind === 'agent'
          ? taskReadColumns(tx).sourceAgentId
          : subject.kind === 'workflow'
            ? taskReadColumns(tx).workflowId
            : taskReadColumns(tx).workgroupId
      const rows = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(column, subject.sourceId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])),
        )
      return rows.map((row) => row.id)
    },
  }
}
