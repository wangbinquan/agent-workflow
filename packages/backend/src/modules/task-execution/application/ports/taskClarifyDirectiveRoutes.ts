import type { Actor } from '@/auth/actor'
import type { TaskActorRole, ClarifyDirective } from '@agent-workflow/shared'

/** Closed transport boundary for the task-scoped clarify directive route. */
export interface TaskClarifyDirectiveRouteOperations {
  resolveAccess(input: { readonly actor: Actor; readonly taskId: string }): Promise<Readonly<{
    readonly workflowSnapshot: string
    readonly actorRole: TaskActorRole | null
  }> | null>
  list(
    taskId: string,
  ): Promise<readonly Readonly<{ readonly nodeId: string; readonly directive: ClarifyDirective }>[]>
  set(input: {
    readonly taskId: string
    readonly nodeId: string
    readonly directive: ClarifyDirective
    readonly setBy: string
    readonly shardKey?: string
  }): Promise<void>
}
