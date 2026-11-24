import type { TaskDeletionEffects } from '../application/ports/taskDeletionContentEffects'
export { requireTaskDeletionContentEffects } from '../application/taskDeletionEffects'
import { createFileTaskDeletionContentEffects } from '../infrastructure/local/fileTaskDeletionContentEffects'

/**
 * RFC-431: the standalone selection — local run files and the git worktree / snapshot-ref participant.
 * RFC-557: the git participant is Source Control's; the standalone bootstrap hands it in.
 */
export function composeLocalTaskDeletionEffects(
  repositories: TaskDeletionEffects['repositories'],
): TaskDeletionEffects {
  return Object.freeze({
    content: createFileTaskDeletionContentEffects(),
    repositories,
  })
}
