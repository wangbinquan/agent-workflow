// RFC-349 — provider-neutral human-gate continuation command.

import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import type {
  HumanGateContinuationLineage,
  HumanGateNodeProjectionFence,
  HumanGateWorkspaceRollbackRef,
} from '../domain/humanGateContinuation'

export interface TaskHumanGateIdentity {
  readonly kind: 'review' | 'clarify'
  readonly ref: string
}

export interface AcceptHumanGateDecisionInput {
  readonly taskId: string
  readonly gate: TaskHumanGateIdentity
  readonly expectedTaskRevision: number
  readonly expectedNodeProjection: HumanGateNodeProjectionFence
  readonly continuationLineage: HumanGateContinuationLineage
  readonly workspaceRollbackPlan?: HumanGateWorkspaceRollbackRef
  readonly operationId: string
  readonly now: number
  readonly nodeChanges?: readonly TaskNodeChangeV1[]
}

export interface AcceptedHumanGateDecision {
  readonly taskRevision: number
  readonly continuationRef: string
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}

/**
 * Named cross-context atom. Implementations commit the task transition,
 * continuation admission, optional rollback effect and committed-event rows in
 * one provider-private transaction.
 */
export interface HumanGateDecisionPersistence {
  accept(input: AcceptHumanGateDecisionInput): Promise<AcceptedHumanGateDecision>
}

export async function acceptHumanGateDecision(
  persistence: HumanGateDecisionPersistence,
  input: AcceptHumanGateDecisionInput,
): Promise<AcceptedHumanGateDecision> {
  return await persistence.accept(input)
}
