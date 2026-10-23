// RFC-395 II-a A1: task projection fixtures preserve supplied mirrors and explicit mounts until II-b.
import { eq } from 'drizzle-orm'
import { deriveTaskCreationLineage } from '@/modules/task-execution/domain/taskCreation'
import { taskRepositoryCount } from '@/modules/task-execution/domain/taskRepository'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { createFixtureAdapter, decodeFixture } from './core'
import { taskRepoFixture, readTaskRepoFixtures, type TaskRepoFixtureRow } from './taskRepo'
import type { TaskFixtureSpec } from './task.spec'
export type { TaskFixtureSpec } from './task.spec'
export type TaskFixtureRow = PersistenceTables['tasks']['$inferSelect'] & {
  repos: TaskRepoFixtureRow[]
}
const adapter = createFixtureAdapter<TaskFixtureSpec, PersistenceTables['tasks'], TaskFixtureRow>({
  table: (db) => tablesOf(db).tasks,
  physicalTable: 'tasks',
  keys: ['id'],
  async prepare(db, row, spec) {
    const { tasks, nodeRuns } = tablesOf(db)
    row.name ??= 'task-' + String(row.id).slice(-10)
    const parent =
      typeof row.parentTaskId === 'string'
        ? await first(db.select().from(tasks).where(eq(tasks.id, row.parentTaskId)))
        : undefined
    const parentRun =
      typeof row.parentNodeRunId === 'string'
        ? await first(db.select().from(nodeRuns).where(eq(nodeRuns.id, row.parentNodeRunId)))
        : undefined
    const lineage = deriveTaskCreationLineage(
      String(row.id),
      spec.workflowVersion ?? null,
      parent
        ? {
            kind: 'child',
            parent,
            parentNodeRunId: spec.parentNodeRunId ?? String(row.id),
            continuationSlotKey:
              parentRun?.continuationSlotKey ?? spec.parentNodeRunId ?? String(row.id),
            parentRunLineageSlotPathJson: parentRun?.lineageSlotPathJson ?? null,
          }
        : { kind: 'root', launchOrigin: spec.launchOrigin ?? 'manual' },
    )
    if (parent) row.launchOrigin = lineage.launchOrigin
    if (row.executionLineageId == null || row.lineageSlotPathJson == null) {
      row.executionLineageId = lineage.executionLineageId
      row.lineageSlotPathJson = lineage.lineageSlotPathJson
    }
    row.repoCount = 1
  },
  async afterWrite(db, row, spec) {
    // II-a writes only the given rows. II-b materializes ordinal 0 from root fields iff worktreePath is nonempty and explicit repos are absent (migration 4.2).
    if (spec.repos?.length)
      await taskRepoFixture(
        db,
        spec.repos.map((repo) => ({ ...repo, taskId: row.id })),
      )
  },
  async project(db, row) {
    const repos = await readTaskRepoFixtures(db, { taskId: row.id })
    return {
      ...decodeFixture('tasks', row),
      repoCount: taskRepositoryCount(repos),
      repos,
    } as TaskFixtureRow
  },
})
export const taskFixture = adapter.insert
export const patchTaskFixture = adapter.patch
export const readTaskFixtures = adapter.read
