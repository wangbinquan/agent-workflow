import type { PlannedDirectoryNode, PlannedRepo } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { eq } from 'drizzle-orm'
import { taskRepos, taskSpaceNodes } from '@/db/schema'
import type { PlannedSpaceLayout } from '../application/ports/preparedWorkspace'
import { ValidationError } from '@/util/errors'

function minimalNodePaths(mountPaths: readonly string[]): string[] {
  const paths = new Map<string, string>([['', '']])
  for (const mountPath of mountPaths) {
    let current = ''
    for (const segment of mountPath.split('/').filter(Boolean)) {
      current = current === '' ? segment : `${current}/${segment}`
      paths.set(current.toLowerCase(), current)
    }
  }
  const depth = (path: string) => path.split('/').filter(Boolean).length
  return [...paths.values()].sort(
    (left, right) => depth(left) - depth(right) || left.localeCompare(right),
  )
}

export async function loadFrozenSpaceLayout(
  db: ProviderNeutralDatabase,
  sourceTaskId: string,
): Promise<PlannedSpaceLayout> {
  const rows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, sourceTaskId))
    .orderBy(taskRepos.repoIndex)
  if (rows.length === 0) {
    throw new ValidationError(
      'source-task-not-replayable',
      `task '${sourceTaskId}' has no frozen repo snapshot to relaunch from`,
    )
  }
  const repos: PlannedRepo[] = []
  for (const row of rows) {
    if (row.cachedRepoId === null || row.cachedRepoId.length === 0) {
      throw new ValidationError(
        'source-task-not-replayable',
        `task '${sourceTaskId}' has a repo with no cached mirror id; its space cannot be replayed`,
      )
    }
    repos.push({
      cachedRepoId: row.cachedRepoId,
      repoUrlRedacted: row.repoUrl ?? '',
      ref: row.baseBranch,
      subdir: row.subdir,
      mountPath: row.mountPath,
      readonly: row.readonly,
      viaGroups: [],
    })
  }
  const frozenNodes = await db
    .select({ path: taskSpaceNodes.nodePath })
    .from(taskSpaceNodes)
    .where(eq(taskSpaceNodes.taskId, sourceTaskId))
  const paths =
    frozenNodes.length > 0
      ? frozenNodes.map((row) => row.path)
      : minimalNodePaths(repos.map((repo) => repo.mountPath))
  const depth = (path: string) => path.split('/').filter(Boolean).length
  const nodes: PlannedDirectoryNode[] = paths
    .sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))
    .map((path) => ({ path, origins: [] }))
  return { repos, nodes }
}
