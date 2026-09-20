// Existing display oracles exercise the production Task projection and SC byte reader.
import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'
import { createWorkspaceContentScope } from '@/modules/source-control/infrastructure/workspaceContent'
export { WORKTREE_DIR_MAX_ENTRIES, WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'

function queries(worktreePath: string) {
  return composeTaskWorkspaceQueries({
    load: async () => ({ worktreePath }),
    contentScope: createWorkspaceContentScope,
  })
}
export function listWorktreeDir(worktreePath: string, relPath: string) {
  return queries(worktreePath).listDisplay('existing-task', relPath)
}
export function readWorktreeFile(worktreePath: string, relPath: string) {
  return queries(worktreePath).readDisplay('existing-task', relPath)
}
