import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'
import type {
  TaskDefinitionProjection,
  TaskSubjectProjection,
  TaskSubjectQueries,
} from '../application/ports/taskSubjectQueries'
import { projectTaskSubject, taskReadSubjectFromDefinition } from '../domain/taskSubject'

export class DatabaseTaskSubjectQueries implements TaskSubjectQueries {
  constructor(private readonly db: PersistenceDb) {}
  async taskSubjectProjection(
    taskIds: readonly string[],
  ): Promise<ReadonlyMap<string, TaskSubjectProjection>> {
    const definitions = await this.taskDefinitionProjection(taskIds)
    return new Map(
      [...definitions].map(([id, value]) => [
        id,
        { workflowId: value.workflowId, workflowName: value.workflowName },
      ]),
    )
  }
  async taskDefinitionProjection(
    taskIds: readonly string[],
  ): Promise<ReadonlyMap<string, TaskDefinitionProjection>> {
    const result = new Map<string, TaskDefinitionProjection>()
    const { taskDefinitions } = tablesOf(this.db)
    const wanted = [...new Set(taskIds)]
    for (let offset = 0; offset < wanted.length; offset += 500) {
      const rows = await this.db
        .select()
        .from(taskDefinitions)
        .where(inArray(taskDefinitions.taskId, wanted.slice(offset, offset + 500)))
      const subjects = rows.map((row) => ({ row, subject: taskReadSubjectFromDefinition(row) }))
      const workflowIds = [
        ...new Set(
          subjects.flatMap(({ subject }) =>
            subject.kind === 'workflow' ? [subject.sourceId] : [],
          ),
        ),
      ]
      const names = new Map(
        (workflowIds.length === 0
          ? []
          : await createWorkflowExecutionQueries(this.db).summaries(workflowIds)
        ).map((row) => [row.id, row.name]),
      )
      for (const { row, subject } of subjects)
        result.set(row.taskId, {
          ...projectTaskSubject(
            subject,
            subject.kind === 'workflow' ? (names.get(subject.sourceId) ?? null) : null,
          ),
          origin: row.definitionOrigin,
        })
    }
    return result
  }
}
