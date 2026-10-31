import type {
  TaskArchiveCollaborationSectionsPort,
  TaskRecoveryHumanGateFactsPort,
  TaskNodeRunClarifyNavPort,
} from '@/modules/task-execution/composition/required-ports'
import type { RecoveryHumanGateFacts, NodeRunClarifyNav } from '../ports/taskCollaborationReads'

export function composeTaskArchiveCollaborationSectionsPort(
  source: TaskArchiveCollaborationSectionsPort,
): TaskArchiveCollaborationSectionsPort {
  return { load: (tx, taskIds) => source.load(tx, taskIds) }
}

export function composeTaskRecoveryHumanGateFactsPort(
  source: RecoveryHumanGateFacts,
): TaskRecoveryHumanGateFactsPort {
  return {
    designerParkEntries: (taskId) => source.designerParkEntries(taskId),
    lifecycleClarifyRounds: (taskIds) => source.lifecycleClarifyRounds(taskIds),
    hasOpenClarifyRound: (taskId) => source.hasOpenClarifyRound(taskId),
  }
}

export function composeTaskNodeRunClarifyNavPort(
  source: NodeRunClarifyNav,
): TaskNodeRunClarifyNavPort {
  return { latestRoundStatusByRun: (taskId) => source.latestRoundStatusByRun(taskId) }
}

import type { TaskMembershipOperationsPort } from '@/modules/task-execution/composition/required-ports'

export function composeTaskMembershipOperationsPort(
  source: TaskMembershipOperationsPort,
): TaskMembershipOperationsPort {
  return {
    canViewTask: (actor, task) => source.canViewTask(actor, task),
    getTaskMembers: (actor, task) => source.getTaskMembers(actor, task),
    requireTaskOperator: (actor, task) => source.requireTaskOperator(actor, task),
    updateTaskMembers: (actor, task, body) => source.updateTaskMembers(actor, task, body),
    assertCanReplaySourceTask: (actor, sourceTaskId) =>
      source.assertCanReplaySourceTask(actor, sourceTaskId),
  }
}

import {
  listCollaborationClarifyDirectives,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { setCollaborationClarifyDirective } from '@/modules/collaboration/public/commands'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import type { TaskClarifyDirectiveRouteOperations } from '@/modules/task-execution/composition/required-ports'

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

import type {
  CollaborationRepairPorts,
  TaskClarifyContinuationPort,
  GateWorkspaceRollbackExecutor,
  TaskReviewersPort,
  HumanGateOpenParticipantFactory,
} from '@/modules/task-execution/composition/required-ports'
import type { ClarifyRepairParticipant } from '../ports/clarifyRepairParticipant'
import type { ReviewRepairParticipant } from '../ports/reviewRepairParticipant'
import type { ClarifyContinuationConvergence } from '../ports/clarifyContinuationConvergence'
import { getReviewNodeReviewerConfig } from '../../public/queries'
import { replaceReviewNodeReviewers } from '../../public/commands'

export function composeCollaborationRepairPorts(
  clarify: ClarifyRepairParticipant,
  review: ReviewRepairParticipant,
): CollaborationRepairPorts {
  return { clarify, review }
}

export function composeTaskGateContinuationSupport(
  rollbackExecutor: GateWorkspaceRollbackExecutor,
  clarifyConvergence: ClarifyContinuationConvergence,
): {
  readonly rollbackExecutor: GateWorkspaceRollbackExecutor
  readonly clarifyConvergence: TaskClarifyContinuationPort
} {
  return { rollbackExecutor, clarifyConvergence }
}

export function composeTaskReviewersPort(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
): TaskReviewersPort {
  return {
    get: (actor, taskId) => getReviewNodeReviewerConfig(context, { actor, taskId }),
    replace: (actor, taskId, body) => replaceReviewNodeReviewers(context, { actor, taskId, body }),
  }
}

export function composeHumanGateOpenParticipantFactory(
  factory: HumanGateOpenParticipantFactory,
): HumanGateOpenParticipantFactory {
  return (input) => factory(input)
}
