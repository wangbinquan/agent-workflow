import type { TaskActorRole } from '@agent-workflow/shared'

import type { ReviewActor } from '../../public/types'

export interface CollaborationTaskSnapshot {
  readonly id: string
  readonly ownerUserId: string | null
  readonly workflowSnapshot: string
}

export interface CollaborationTaskAccessDecision {
  readonly task: CollaborationTaskSnapshot | null
  readonly visible: boolean
  readonly actorRole: TaskActorRole | null
}

export interface CollaborationNodeRunTaskAccessDecision extends CollaborationTaskAccessDecision {
  readonly nodeRunExists: boolean
  readonly taskId: string | null
}

export interface CollaborationClarifyTaskAccessDecision extends CollaborationTaskAccessDecision {
  readonly roundExists: boolean
  readonly nodeRunExists: boolean
  readonly taskId: string | null
}

/**
 * Closed task/relationship reads shared by collaboration transports.  The
 * caller receives only the frozen task fields required by the route oracle;
 * provider rows and query builders stay in infrastructure.
 */
export interface CollaborationTaskAccessPort {
  resolveTask(actor: ReviewActor, taskId: string): Promise<CollaborationTaskAccessDecision>
  resolveNodeRunTask(
    actor: ReviewActor,
    nodeRunId: string,
  ): Promise<CollaborationNodeRunTaskAccessDecision>
  resolveClarifyRoundTask(
    actor: ReviewActor,
    intermediaryNodeRunId: string,
  ): Promise<CollaborationClarifyTaskAccessDecision>
  visibleTaskIds(actor: ReviewActor, taskIds: readonly string[]): Promise<ReadonlySet<string>>
  questionTaskId(entryId: string): Promise<string | null>
}
