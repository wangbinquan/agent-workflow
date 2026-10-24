import type {
  TaskArchiveCollaborationSectionsPort,
  TaskRecoveryHumanGateFactsPort,
  TaskNodeRunClarifyNavPort,
} from '@/modules/task-execution/composition/required-ports'
import type {
  ArchiveCollaborationSections,
  RecoveryHumanGateFacts,
  NodeRunClarifyNav,
} from '../ports/taskCollaborationReads'

export function composeTaskArchiveCollaborationSectionsPort(
  source: ArchiveCollaborationSections,
): TaskArchiveCollaborationSectionsPort {
  return { sections: source.sections, load: (taskIds) => source.load(taskIds) }
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
