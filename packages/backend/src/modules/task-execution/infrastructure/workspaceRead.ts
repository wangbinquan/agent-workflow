import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import type { WorkspaceContentParticipant } from '@/modules/source-control/public/participants'
import type { AuthorizedWorkspaceSnapshotRef } from '@/modules/source-control/public/types'
import { NotFoundError } from '@/util/errors'
import type { TaskWorkspaceReadScope } from '../application/workspaceRead'
import type {
  TaskWorkspaceReadPort,
  WorkspaceReadCapability,
} from '../application/ports/workspaceLaunch'

/** Root injects SC's physical binding factory; Task never imports SC composition. */
export interface TaskWorkspaceReadDependencies {
  readonly load: (taskId: string) => Promise<{ readonly worktreePath: string } | null>
  readonly contentScope: (worktreePath: string) => {
    readonly snapshot: AuthorizedWorkspaceSnapshotRef
    readonly participant: WorkspaceContentParticipant
    close(): void
  }
}

// RFC-535: the scope itself decides whether a capability is live (not closed, and the very object it issued); there is
// no process-level set of live capabilities.
function createWorkspaceReadCapability(): WorkspaceReadCapability {
  return Object.freeze({}) as WorkspaceReadCapability
}

export async function bindTaskWorkspaceReadScope(
  input: TaskWorkspaceReadDependencies,
  taskId: string,
): Promise<TaskWorkspaceReadScope> {
  const binding = await input.load(taskId)
  if (binding === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  if (isTaskWorkspaceUnbound(binding.worktreePath))
    throw new NotFoundError('task-worktree-missing', `task '${taskId}' has no worktree`)
  const content = input.contentScope(binding.worktreePath)
  const capability = createWorkspaceReadCapability()
  let live = true
  function assertBound(candidate: WorkspaceReadCapability) {
    if (!live || candidate !== capability)
      throw new Error('task-workspace-read-scope-ended-or-mismatched')
  }
  const port = Object.freeze<TaskWorkspaceReadPort>({
    async list(candidate, request) {
      assertBound(candidate)
      const result = await content.participant.list(content.snapshot, request)
      assertBound(candidate)
      return result
    },
    async read(candidate, request) {
      assertBound(candidate)
      const result = await content.participant.read(content.snapshot, request)
      assertBound(candidate)
      return result
    },
  })
  return {
    port,
    capability,
    close() {
      live = false
      content.close()
    },
  }
}
