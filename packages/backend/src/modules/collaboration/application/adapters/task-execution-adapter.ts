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
