// RFC-557: the standalone deletion selection — Task Execution's local run-file effects plus Source Control's git
// worktree / snapshot-ref participant. The standalone bootstrap composes the same pair (`src/bootstrap/standalone.ts`);
// Task Execution's composition no longer reaches into Source Control for it.
import { createGitTaskDeletionRepositoryEffects } from '@/modules/source-control/composition'
import { composeLocalTaskDeletionEffects } from '@/modules/task-execution/composition/taskDeletionEffects'

export function composeStandaloneTaskDeletionEffects(): ReturnType<
  typeof composeLocalTaskDeletionEffects
> {
  return composeLocalTaskDeletionEffects(createGitTaskDeletionRepositoryEffects())
}
