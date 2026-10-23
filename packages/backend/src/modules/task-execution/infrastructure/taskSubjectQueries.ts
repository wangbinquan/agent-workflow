import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'
import { inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type {
  TaskDefinitionProjection,
  TaskSubjectProjection,
  TaskSubjectQueries,
} from '../application/ports/taskSubjectQueries'
import {
  decodeTaskSubject,
  definitionHost,
  projectTaskSubject,
  taskDefinitionOrigin,
} from '../domain/taskSubject'

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
    const { tasks } = tablesOf(this.db)
    const wanted = [...new Set(taskIds)]
    for (let offset = 0; offset < wanted.length; offset += 500) {
      const rows = await this.db
        .select({
          id: tasks.id,
          workflowId: tasks.workflowId,
          codeRoundId: tasks.codeRoundId,
          workgroupId: tasks.workgroupId,
          sourceAgentId: tasks.sourceAgentId,
          sourceAgentName: tasks.sourceAgentName,
        })
        .from(tasks)
        .where(inArray(tasks.id, wanted.slice(offset, offset + 500)))
      const subjects = rows.map((row) => ({ id: row.id, subject: decodeTaskSubject(row) }))
      const workflowIds = [
        ...new Set(
          subjects.flatMap(({ subject }) =>
            subject.kind === 'workflow' && definitionHost(subject.sourceId) === null
              ? [subject.sourceId]
              : [],
          ),
        ),
      ]
      const names = new Map(
        workflowIds.length === 0
          ? []
          : (
              await createWorkflowExecutionQueries(this.db)
                .summaries(workflowIds)
                .then((rows) =>
                  rows.map((row) => ({ id: row.id, name: row.name, builtin: row.builtin })),
                )
            ).map((row) => [row.id, row]),
      )
      for (const { id, subject } of subjects) {
        const workflow = subject.kind === 'workflow' ? names.get(subject.sourceId) : undefined
        result.set(id, {
          ...projectTaskSubject(subject, workflow?.name ?? null),
          origin: taskDefinitionOrigin(subject, workflow?.builtin === true),
        })
      }
    }
    return result
  }
}
