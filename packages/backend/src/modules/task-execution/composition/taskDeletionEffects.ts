import type {
  TaskDeletionContentEffects,
  TaskDeletionEffects,
} from '../application/ports/taskDeletionContentEffects'
import { createFileTaskDeletionContentEffects } from '../infrastructure/local/fileTaskDeletionContentEffects'
import { createGitTaskDeletionRepositoryEffects } from '@/modules/source-control/composition'

export function requireTaskDeletionContentEffects(
  value: unknown,
): asserts value is TaskDeletionContentEffects {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as TaskDeletionContentEffects).directories !== 'function' ||
    typeof (value as TaskDeletionContentEffects).removeIfPresent !== 'function'
  ) {
    throw new TypeError('Task deletion requires a complete content effects receiver')
  }
}

export function selectedTaskDeletionEffects(selected?: TaskDeletionEffects): TaskDeletionEffects {
  const effects =
    selected === undefined
      ? Object.freeze({
          content: createFileTaskDeletionContentEffects(),
          repositories: createGitTaskDeletionRepositoryEffects(),
        })
      : selected
  if (effects === null || typeof effects !== 'object')
    throw new TypeError('Task deletion requires complete effects')
  requireTaskDeletionContentEffects(effects.content)
  const repositories = effects.repositories
  if (
    repositories === null ||
    typeof repositories !== 'object' ||
    typeof repositories.removeWorktree !== 'function' ||
    typeof repositories.deleteSnapshotRefs !== 'function'
  ) {
    throw new TypeError('Task deletion requires a complete repository participant')
  }
  return effects
}
