import type { TaskDeletionEffects } from '../application/ports/taskDeletionContentEffects'
import { requireTaskDeletionEffects } from '../application/taskDeletionEffects'
export { requireTaskDeletionContentEffects } from '../application/taskDeletionEffects'
import { createFileTaskDeletionContentEffects } from '../infrastructure/local/fileTaskDeletionContentEffects'
import { createGitTaskDeletionRepositoryEffects } from '@/modules/source-control/composition'

/** RFC-431: the standalone selection — local run files and the git worktree / snapshot-ref participant. */
export function composeLocalTaskDeletionEffects(): TaskDeletionEffects {
  return Object.freeze({
    content: createFileTaskDeletionContentEffects(),
    repositories: createGitTaskDeletionRepositoryEffects(),
  })
}

export function selectedTaskDeletionEffects(selected?: TaskDeletionEffects): TaskDeletionEffects {
  const effects = selected === undefined ? composeLocalTaskDeletionEffects() : selected
  requireTaskDeletionEffects(effects)
  return effects
}
