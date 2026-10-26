// Mount keys stay stable while ordinal and workspace paths remain projections.
import { and, asc, eq } from 'drizzle-orm'
import { taskMountAtCreation } from '@/modules/task-execution/domain/taskCreation'
import {
  taskMountReadColumns,
  projectTaskMountReadRow,
  type TaskMountReadRow,
} from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { writeTaskWorkspaceDirectoriesInTx } from '@/modules/task-execution/infrastructure/taskWorkspaceDirectoryParticipant'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  createFixtureAdapter,
  fixtureRows,
  fixtureTransaction,
  encodeFixture,
  physicalFixtureValues,
  type FixtureHandle,
  type FixtureOptions,
} from './core'
import type { TaskRepoFixtureSpec } from './taskRepo.spec'
export type { TaskRepoFixtureSpec } from './taskRepo.spec'
export type TaskRepoFixtureRow = Omit<TaskMountReadRow, 'worktreeDirName'>
export function taskRepoFixtureMount(spec: TaskRepoFixtureSpec) {
  return {
    ordinal: spec.repoIndex,
    mountPath: spec.mountPath ?? '',
    repoPath: spec.repoPath,
    repoUrl: spec.repoUrl ?? null,
    cachedRepoId: spec.cachedRepoId ?? null,
    baseBranch: spec.baseBranch ?? '',
    branch: spec.branch,
    workingBranch: spec.workingBranch ?? null,
    baseCommit: spec.baseCommit ?? null,
    worktreePath: spec.worktreePath,
    subdir: spec.subdir ?? '',
    readonly: spec.readonly ?? false,
    readonlyDirtyCount: spec.readonlyDirtyCount ?? null,
    workspaceProfileVersion: spec.workspaceProfileVersion ?? null,
    workspaceProfileDigest: spec.workspaceProfileDigest ?? null,
    hasSubmodules: spec.hasSubmodules ?? null,
    submoduleInitOk: spec.submoduleInitOk ?? null,
    submoduleInitError: spec.submoduleInitError ?? null,
  }
}
export async function refreshFixtureRepoCount(db: FixtureHandle, taskId: string): Promise<void> {
  const { taskRepositoryMounts: mounts } = tablesOf(db)
  const rows = await db
    .select({ mountPath: mounts.mountPath })
    .from(mounts)
    .where(eq(mounts.taskId, taskId))
  await writeTaskWorkspaceDirectoriesInTx(
    db,
    taskId,
    rows.map((row) => row.mountPath),
    [],
  )
}
const adapter = createFixtureAdapter<
  TaskRepoFixtureSpec,
  PersistenceTables['taskRepositoryMounts'],
  TaskRepoFixtureRow
>({
  table: (db) => tablesOf(db).taskRepositoryMounts,
  physicalTable: 'task_repos',
  keys: ['taskId', 'repoKey'],
  columns: taskMountReadColumns,
  async prepare(_db, row, spec) {
    Object.assign(row, taskMountAtCreation(spec.taskId, taskRepoFixtureMount(spec)))
  },
  async afterWrite(db, row) {
    await refreshFixtureRepoCount(db, row.taskId)
  },
  rootPatch() {
    return {}
  },
  async afterPatch(db, row, spec) {
    const table = tablesOf(db).taskRepositoryMounts
    const patch = physicalFixtureValues(table, encodeFixture('task_repos', spec))
    if (spec.repoIndex !== undefined) patch.ordinal = spec.repoIndex
    if (
      typeof spec.branch === 'string' ||
      spec.baseCommit !== undefined ||
      typeof spec.baseBranch === 'string'
    ) {
      const branch = typeof spec.branch === 'string' ? spec.branch : (row.branch ?? '')
      const baseCommit = spec.baseCommit === undefined ? row.baseCommit : spec.baseCommit
      Object.assign(patch, {
        branch: branch || null,
        branchState: branch ? 'branch' : baseCommit ? 'detached' : 'none',
        baseBranch: (spec.baseBranch ?? row.baseBranch) || null,
      })
    }
    if (Object.keys(patch).length)
      await db
        .update(table)
        .set(patch)
        .where(and(eq(table.taskId, row.taskId), eq(table.repoKey, row.repoKey)))
    await refreshFixtureRepoCount(db, row.taskId)
  },
  async project(db, row) {
    const table = tablesOf(db).taskRepositoryMounts
    const [value] = await db
      .select(taskMountReadColumns(db))
      .from(table)
      .where(and(eq(table.taskId, row.taskId), eq(table.repoKey, row.repoKey)))
    const { worktreeDirName: _directory, ...result } = projectTaskMountReadRow(value!)
    return result
  },
})
export async function taskRepoFixture(
  db: FixtureHandle,
  input: TaskRepoFixtureSpec | readonly TaskRepoFixtureSpec[],
  options: FixtureOptions = {},
) {
  return fixtureTransaction(db, async (tx) => {
    const table = tablesOf(tx).taskRepositoryMounts
    const result: TaskRepoFixtureRow[] = []
    for (const spec of fixtureRows(input)) {
      const [existing] = await tx
        .select()
        .from(table)
        .where(and(eq(table.taskId, spec.taskId), eq(table.ordinal, spec.repoIndex)))
      if (!existing) result.push(...(await adapter.insert(tx, spec, options)))
      else if (options.onConflict !== 'ignore') {
        const values = taskMountAtCreation(spec.taskId, taskRepoFixtureMount(spec))
        await tx
          .update(table)
          .set(physicalFixtureValues(table, { ...values, repoKey: existing.repoKey }))
          .where(and(eq(table.taskId, spec.taskId), eq(table.repoKey, existing.repoKey)))
        await refreshFixtureRepoCount(tx, spec.taskId)
        result.push(...(await adapter.read(tx, { taskId: spec.taskId, repoIndex: spec.repoIndex })))
      }
    }
    return result
  })
}
export const readTaskRepoFixtures = adapter.read
export const patchTaskRepoFixture = adapter.patch
export async function readStoredTaskRepoFixtures(db: FixtureHandle, taskId: string) {
  const { taskRepositoryMounts: mounts } = tablesOf(db)
  return db.select().from(mounts).where(eq(mounts.taskId, taskId)).orderBy(asc(mounts.ordinal))
}
/** There is one persisted mount path; directory names are derived by the public projection. */
export async function patchStoredTaskRepoDirectory(
  db: FixtureHandle,
  taskId: string,
  repoIndex: number,
  mountPath: string,
): Promise<void> {
  await patchTaskRepoFixture(db, { taskId, repoIndex }, { mountPath })
}
