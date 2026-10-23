// RFC-395 II-a A1: repository fixtures own the temporary repo-count mirror and directory-name encoding.
import { and, eq } from 'drizzle-orm'
import { taskRepositoryMountIdentity } from '@/modules/task-execution/infrastructure/taskRepositoryCodec'
import { taskRepositoryCount } from '@/modules/task-execution/domain/taskRepository'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  createFixtureAdapter,
  decodeFixture,
  fixtureTransaction,
  type FixtureHandle,
  type FixturePatch,
} from './core'
import type { TaskRepoFixtureSpec } from './taskRepo.spec'
export type { TaskRepoFixtureSpec } from './taskRepo.spec'
export type TaskRepoFixtureRow = Omit<
  PersistenceTables['taskRepos']['$inferSelect'],
  'worktreeDirName'
>
export async function refreshFixtureRepoCount(db: FixtureHandle, taskId: string): Promise<void> {
  const { tasks, taskRepos } = tablesOf(db)
  const repos = await db
    .select({ repoIndex: taskRepos.repoIndex })
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
  await db
    .update(tasks)
    .set({ repoCount: taskRepositoryCount(repos) })
    .where(eq(tasks.id, taskId))
}
const adapter = createFixtureAdapter<
  TaskRepoFixtureSpec,
  PersistenceTables['taskRepos'],
  TaskRepoFixtureRow
>({
  table: (db) => tablesOf(db).taskRepos,
  physicalTable: 'task_repos',
  keys: ['taskId', 'repoIndex'],
  prepare: async (_db, row, spec) => {
    Object.assign(row, taskRepositoryMountIdentity(spec.mountPath ?? ''))
  },
  afterWrite: async (db, row) => {
    await refreshFixtureRepoCount(db, row.taskId)
  },
  project: async (_db, row) => decodeFixture('task_repos', row) as TaskRepoFixtureRow,
})
export const taskRepoFixture = adapter.insert
export const readTaskRepoFixtures = adapter.read
export async function patchTaskRepoFixture(
  db: FixtureHandle,
  where: Partial<TaskRepoFixtureSpec> | undefined,
  values: FixturePatch<TaskRepoFixtureSpec>,
): Promise<number> {
  return fixtureTransaction(db, async (tx) => {
    const before = await adapter.read(tx, where)
    const count = await adapter.patch(tx, where, values)
    if (values.mountPath !== undefined) {
      const { taskRepos } = tablesOf(tx)
      for (const row of before) {
        await tx
          .update(taskRepos)
          .set(
            typeof values.mountPath === 'string'
              ? taskRepositoryMountIdentity(values.mountPath)
              : { worktreeDirName: values.mountPath },
          )
          .where(and(eq(taskRepos.taskId, row.taskId), eq(taskRepos.repoIndex, row.repoIndex)))
      }
    }
    // RFC-395 II-a: patching workspace columns must not rewrite an unrelated stored count.
    if (typeof values.taskId === 'string') {
      for (const row of before) await refreshFixtureRepoCount(tx, row.taskId)
      await refreshFixtureRepoCount(tx, values.taskId)
    }
    return count
  })
}

/** Epoch-1 import fixture: expose the stored directory independently of the mount path. */
export async function readStoredTaskRepoFixtures(db: FixtureHandle, taskId: string) {
  const { taskRepos } = tablesOf(db)
  return await db.select().from(taskRepos).where(eq(taskRepos.taskId, taskId))
}

export async function patchStoredTaskRepoDirectory(
  db: FixtureHandle,
  taskId: string,
  repoIndex: number,
  worktreeDirName: string,
): Promise<void> {
  const { taskRepos } = tablesOf(db)
  await db
    .update(taskRepos)
    .set({ worktreeDirName })
    .where(and(eq(taskRepos.taskId, taskId), eq(taskRepos.repoIndex, repoIndex)))
}
