import {
  listCollaborationClarifyDirectives,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { setCollaborationClarifyDirective } from '@/modules/collaboration/public/commands'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import type { TaskClarifyDirectiveRouteOperations } from '../public/types'

/**
 * Bind the selected Collaboration provider once. The HTTP route receives only
 * the closed operations below and never needs its command context or database.
 */
export function composeTaskClarifyDirectiveRouteOperations(
  collaboration: CollaborationCommandContext,
): TaskClarifyDirectiveRouteOperations {
  return Object.freeze({
    async resolveAccess(
      input: Parameters<TaskClarifyDirectiveRouteOperations['resolveAccess']>[0],
    ) {
      const access = await resolveCollaborationTaskAccess(collaboration, input)
      if (access.task === null || !access.visible) return null
      return Object.freeze({
        workflowSnapshot: access.task.workflowSnapshot,
        actorRole: access.actorRole,
      })
    },
    list: async (taskId: string) => await listCollaborationClarifyDirectives(collaboration, taskId),
    set: async (input: Parameters<TaskClarifyDirectiveRouteOperations['set']>[0]) =>
      await setCollaborationClarifyDirective(collaboration, input),
  })
}
