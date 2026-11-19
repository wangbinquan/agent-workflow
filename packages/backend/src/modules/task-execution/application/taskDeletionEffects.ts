// RFC-510 — task deletion completeness checks: the selected content effects and repository participant are complete.
import type {
  TaskDeletionContentEffects,
  TaskDeletionEffects,
} from './ports/taskDeletionContentEffects'

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

export function requireTaskDeletionEffects(effects: TaskDeletionEffects): void {
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
}
