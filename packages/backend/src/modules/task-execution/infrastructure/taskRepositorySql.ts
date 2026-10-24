import { eq, sql, type SQLWrapper } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { isTaskWorkspaceUnbound } from '@/platform/taskRepository'

/** Epoch-1 encoding of requestedSource@v1; keep the existing indexed SQL shape. */
export function taskRequestedSourceColumns(db: object) {
  const { tasks } = tablesOf(db)
  return {
    repoUrl: tasks.repoUrl,
    cachedRepoId: tasks.cachedRepoId,
    baseBranch: tasks.baseBranch,
    repoGroupId: tasks.repoGroupId,
    repoGroupName: tasks.repoGroupName,
    spaceKind: tasks.spaceKind,
  }
}

export function taskWorkspaceUnboundSql(root: SQLWrapper) {
  return eq(root, '')
}

export function taskWorkspaceRootMatchesSql(root: SQLWrapper, expected: string) {
  return isTaskWorkspaceUnbound(expected) ? taskWorkspaceUnboundSql(root) : eq(root, expected)
}

/** A requested source counts only when there are no materialized mount rows, as before. */
export function taskRequestedSourceReferenceSql(db: object, cachedRepoId: SQLWrapper) {
  const { tasks, taskRepos } = tablesOf(db)
  const source = taskRequestedSourceColumns(db)
  // A scalar LIMIT probe keeps the candidate key in the owner read.
  return sql`coalesce((
    select true from ${tasks} where ${source.cachedRepoId} = ${cachedRepoId}
      and not exists (select 1 from ${taskRepos} where ${taskRepos.taskId} = ${tasks.id})
    limit 1
  ), false)`
}
