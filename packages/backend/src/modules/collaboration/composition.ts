// RFC-333 — collaboration composition root. Legacy callers enter through one
// temporary service bridge until their constructors receive these dependencies.

// RFC-359 W4-B3：实现只有一份；provider 具名导出只做绑定（bootstrap 收敛后一并删）。
export {
  createCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createSqliteCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createPostgresqlCollaborationTaskAccessPort,
} from './infrastructure/collaborationTaskAccess'
export { planMembersReplacement } from './infrastructure/legacySqliteTaskCollab'
// RFC-359 W7：RFC-057 修复的两个协作侧端口也各只剩一份实现；provider 具名导出只做绑定。
export {
  createClarifyRepairParticipant,
  createClarifyRepairParticipant as createSqliteClarifyRepairParticipant,
  createClarifyRepairParticipant as createPostgresqlClarifyRepairParticipant,
} from './infrastructure/clarifyRepairParticipant'
export {
  createReviewRepairParticipant,
  createReviewRepairParticipant as createSqliteReviewRepairParticipant,
  createReviewRepairParticipant as createPostgresqlReviewRepairParticipant,
} from './infrastructure/reviewRepairParticipant'
// RFC-359 W7：运行期机制合一后只剩一个工厂（`infrastructure/collaborationRuntimeMechanics.ts`）。
export { createCollaborationRuntimeMechanics } from './infrastructure/collaborationRuntimeMechanics'
export {
  createCollaborationWsProjector,
  createSqliteCollaborationCommittedEventProjection,
} from './infrastructure/collaborationCommittedEventWsProjector'
export { createPostgresqlCollaborationCommittedEventProjection } from './infrastructure/postgresqlCollaborationCommittedEventProjection'
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
export {
  createCollaborationCommandContext,
  createPostgresqlCollaborationCommandContext,
} from './composition/commandContext'
export {
  composeWorkgroupTaskRoomClarifyParticipantFactory,
  type WorkgroupTaskRoomClarifyParticipantFactory,
} from './composition/workgroupTaskRoomClarify'

// RFC-359 W8 —— 「RFC-333 temporary legacy bridge inventory」那一块（11 个 domain /
// application 纯函数 + `GitWorkspaceRollbackSnapshotInspector`）已删除。它唯一的消费者
// `services/humanGateComposition.ts` 改成逐个从定义模块直取，理由写在那个文件顶部：
// 经本 barrel 取用会把整个 collaboration 的实现面拖进依赖图，W7 之后当场闭掉 9 条
// `no-circular`。本 barrel 此后**只导出装配用的工厂**，不再转售 domain 纯函数——
// 想用 domain / application 的函数请直接 import 定义模块。
