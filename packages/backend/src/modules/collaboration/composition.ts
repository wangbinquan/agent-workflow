// RFC-400 — collaboration construction exports for bootstrap.

// RFC-359 W4-B3：实现只有一份；provider 具名导出只做绑定（bootstrap 收敛后一并删）。
export {
  createCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createSqliteCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createPostgresqlCollaborationTaskAccessPort,
} from './infrastructure/collaborationTaskAccess'
export { planMembersReplacement } from './infrastructure/taskCollab'
/** RFC-370: the deployment's review journal content and rollback snapshot
 * selections, passed through the daemon roots unopened. */
export type { ReviewArtifactSelection } from './application/ports/reviewArtifactSelection'
export type { WorkspaceRollbackSnapshotInspector } from './application/prepareWorkspaceRollbackPlan'
// RFC-388：修复参与者只有中立工厂，两个部署共用。
export { createClarifyRepairParticipant } from './infrastructure/clarifyRepairParticipant'
export { createReviewRepairParticipant } from './infrastructure/reviewRepairParticipant'
// RFC-359 W7：运行期机制合一后只剩一个工厂（`infrastructure/collaborationRuntimeMechanics.ts`）。
export { createCollaborationRuntimeMechanics } from './infrastructure/collaborationRuntimeMechanics'
// RFC-359 W9：已提交事件的 WS 投影合一后只剩一个工厂
// （`infrastructure/collaborationCommittedEventWsProjector.ts`）。
export {
  createCollaborationWsProjector,
  createCollaborationCommittedEventProjection,
} from './infrastructure/collaborationCommittedEventWsProjector'
export {
  createHumanGateContinuationRecoveryQueries,
  createHumanGateContinuationRecoveryQueries as createSqliteHumanGateContinuationRecoveryQueries,
  createHumanGateContinuationRecoveryQueries as createPostgresqlHumanGateContinuationRecoveryQueries,
} from './infrastructure/humanGateContinuationRecovery'
export {
  createHumanGateTerminalSweepCommand,
  createHumanGateTerminalSweepCommand as createSqliteHumanGateTerminalSweepCommand,
  createHumanGateTerminalSweepCommand as createPostgresqlHumanGateTerminalSweepCommand,
} from './infrastructure/humanGateTerminalSweep'
export { createCollaborationClarifyDraftEventPublisher } from './infrastructure/collaborationClarifyDraftEventPublisher'
// RFC-359 W7：路由持久化面合一后只剩一个工厂（`infrastructure/collaborationRouteOperations.ts`）。
export {
  createCollaborationRouteOperations,
  type CreateCollaborationRouteOperationsInput,
} from './infrastructure/collaborationRouteOperations'
export { createCollaborationCommandContext } from './infrastructure/collaborationCommandContext'
export {
  composeWorkgroupTaskRoomClarifyParticipantFactory,
  type WorkgroupTaskRoomClarifyParticipantFactory,
} from './composition/workgroupTaskRoomClarify'

// 这里只导出装配工厂；domain / application 函数由消费者直接引用定义模块。
export { createCommittedHumanInputQueries } from './infrastructure/committedHumanInputQueries'

export { createClarifyAnswerQueries } from './infrastructure/clarifyAnswerQueries'
export { schemaContribution } from './composition/schema'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeTaskArchiveCollaborationSectionsPort,
  composeTaskRecoveryHumanGateFactsPort,
  composeTaskNodeRunClarifyNavPort,
} from './application/adapters/task-execution-adapter'
import {
  createTaskArchiveCollaborationSectionReader,
  createTaskRecoveryHumanGateFacts,
  createTaskNodeRunClarifyNav,
} from './infrastructure/taskCollaborationReads'

export function composeTaskCollaborationReads(db: PersistenceDb) {
  return {
    archive: composeTaskArchiveCollaborationSectionsPort(
      createTaskArchiveCollaborationSectionReader(),
    ),
    recovery: composeTaskRecoveryHumanGateFactsPort(createTaskRecoveryHumanGateFacts(db)),
    clarifyNav: composeTaskNodeRunClarifyNavPort(createTaskNodeRunClarifyNav(db)),
  }
}

import type { CollaborationTaskRolePolicy } from './application/ports/collaborationTaskRolePolicy'
import { composeTaskMembershipOperationsPort } from './application/adapters/task-execution-adapter'
import {
  canViewTask,
  getTaskMembers,
  requireTaskOperator,
  updateTaskMembers,
  assertCanReplaySourceTask,
} from './infrastructure/taskCollab'

export function composeTaskMembershipOperations(
  db: PersistenceDb,
  policy: CollaborationTaskRolePolicy,
) {
  return composeTaskMembershipOperationsPort({
    canViewTask: (actor, task) => canViewTask(db, actor, task),
    getTaskMembers: (actor, task) => getTaskMembers(db, policy, actor, task),
    requireTaskOperator: (actor, task) => requireTaskOperator(db, policy, actor, task),
    updateTaskMembers: (actor, task, body) => updateTaskMembers(db, policy, actor, task, body),
    assertCanReplaySourceTask: (actor, sourceTaskId) =>
      assertCanReplaySourceTask(db, actor, sourceTaskId),
  })
}

export { composeTaskClarifyDirectiveRouteOperations } from './application/adapters/task-execution-adapter'

import {
  composeCollaborationRepairPorts as bindCollaborationRepairPorts,
  composeTaskGateContinuationSupport,
  composeHumanGateOpenParticipantFactory as bindHumanGateOpenParticipantFactory,
} from './application/adapters/task-execution-adapter'
import { createClarifyRepairParticipant } from './infrastructure/clarifyRepairParticipant'
import { createReviewRepairParticipant } from './infrastructure/reviewRepairParticipant'
import { GateWorkspaceRollbackExecutorAdapter } from './infrastructure/gateWorkspaceRollbackExecutor'
import { DatabaseHumanGateOperationPersistence } from './infrastructure/humanGateOperationPersistence'
import { createHumanGateOpenParticipantScope } from './infrastructure/humanGateOpenFactory'
import { createClarifyContinuationConvergence } from './infrastructure/clarifyContinuationConvergence'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { HumanGateTaskLockPort } from './composition/required-ports'

export function composeCollaborationRepairPorts(db: PersistenceDb) {
  return bindCollaborationRepairPorts(
    createClarifyRepairParticipant(db),
    createReviewRepairParticipant(db),
  )
}

export function composeGateContinuationSupport(
  input: Parameters<typeof createClarifyContinuationConvergence>[0] & {
    readonly taskLock: HumanGateTaskLockPort
    readonly historyRestrictions: HistoryRestrictionPort
  },
) {
  const operations = new DatabaseHumanGateOperationPersistence(
    databaseSessionFor(input.db),
    input.taskLock,
    { historyRestrictions: input.historyRestrictions },
  )
  const clarifyConvergence = createClarifyContinuationConvergence(input)
  return composeTaskGateContinuationSupport(
    new GateWorkspaceRollbackExecutorAdapter(operations),
    clarifyConvergence,
  )
}

export { composeTaskReviewersPort } from './application/adapters/task-execution-adapter'

export function composeHumanGateOpenParticipantFactory() {
  return bindHumanGateOpenParticipantFactory(createHumanGateOpenParticipantScope)
}
