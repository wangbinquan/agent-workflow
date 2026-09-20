// Historical Tasks have no preparation journal. Keep their existing reclaim
// algorithm at the physical owner; journaled Tasks must never enter this path.
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit, withWorktreeRegistryLock } from '@/util/git'
import { ConflictError, diagnosticTextOf as diagnosticText } from '@/util/errors'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'

export interface LegacyWorkspaceRecoveryLog {
  warn(message: string, context: Readonly<Record<string, string>>): void
}

export async function reclaimLegacyWorkspaceArtifacts(
  dependencies: {
    appHome: string
    store: RepositoryWorkspaceStore
    log: LegacyWorkspaceRecoveryLog
  },
  task: { id: string; cachedRepoId: string | null; repoGroupId: string | null },
): Promise<void> {
  if (!/^[0-9A-Za-z_-]+$/.test(task.id)) {
    throw new ConflictError(
      'task-id-filesystem-unsafe',
      `task '${task.id}' cannot identify repository-preparation artifacts safely`,
    )
  }
  const store = dependencies.store
  const cachedRepoIds = new Set<string>()
  if (task.cachedRepoId !== null && task.cachedRepoId.length > 0) {
    cachedRepoIds.add(task.cachedRepoId)
  }
  if (task.repoGroupId !== null && task.repoGroupId.length > 0) {
    try {
      const layout = await resolveRepoGroupLayout(store, task.repoGroupId)
      for (const repository of layout.repos) cachedRepoIds.add(repository.cachedRepoId)
    } catch (error) {
      dependencies.log.warn('could not resolve repository group while reclaiming retry artifacts', {
        taskId: task.id,
        error: diagnosticText(error),
      })
    }
  }

  const worktreesRoot = join(dependencies.appHome, 'worktrees')
  try {
    for (const directory of await readdir(worktreesRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      await rm(join(worktreesRoot, directory.name, task.id), { recursive: true, force: true })
    }
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code
    if (code !== 'ENOENT') {
      dependencies.log.warn('could not reclaim stale repository-preparation directories', {
        taskId: task.id,
        error: diagnosticText(error),
      })
    }
  }

  for (const cachedRepoId of cachedRepoIds) {
    const repository = await store.findCachedRepoById(cachedRepoId)
    if (repository === null) continue
    try {
      await withWorktreeRegistryLock(repository.localPath, async () => {
        await runGit(repository.localPath, ['worktree', 'prune'])
        const listed = await runGit(repository.localPath, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/agent-workflow/${task.id}`,
          `refs/heads/agent-workflow/${task.id}-*`,
        ])
        for (const ref of listed.stdout
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean)) {
          await runGit(repository.localPath, ['update-ref', '-d', ref])
        }
      })
    } catch (error) {
      dependencies.log.warn('could not reclaim stale repository-preparation Git state', {
        taskId: task.id,
        cachedRepoId,
        error: diagnosticText(error),
      })
    }
  }
}
