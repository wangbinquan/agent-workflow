export {
  composeTaskExecutionRuntime,
  type TaskExecutionRuntime,
  type TaskRepositoryPublicationTransport,
} from './runtimeAssembly'
export { createTaskExecutionPersistence } from './taskExecutionPersistence'
export {
  composeLegacyTaskActivityParticipant,
  composeLegacyTaskStopRegistry,
  createTaskExecutionRuntimeParticipants,
  type TaskExecutionRuntimeParticipantsInput,
} from '../infrastructure/taskExecutionRuntimeParticipants'
export {
  composeWorkgroupHostLedgerParticipantFactory,
  type WorkgroupHostLedgerParticipantFactory,
} from './workgroupHostLedger'
export {
  composeWorkgroupTaskRoomTaskParticipantFactory,
  type WorkgroupTaskRoomClarifyParticipantFactory,
  type WorkgroupTaskRoomTaskParticipantFactory,
} from './workgroupTaskRoomTask'
export {
  createChildTaskLifecycleParticipant,
  type ChildTaskLifecycleDependencies,
  type ChildTaskLifecycleRuntimePorts,
} from './childTaskLifecycle'
export {
  createChildExecutionLaunchOperations,
  type ChildExecutionLaunchDependencies,
  type ChildWorkgroupLaunchResources,
} from './childExecutionLaunch'
export { composeTaskClarifyDirectiveRouteOperations } from './taskClarifyDirectiveRoutes'
export { composeTaskAutoResumeCommand } from './taskAutoResume'
export type {
  RepositoryPreparationRetryCommand,
  TaskAutoResumeCommand,
  TaskAutoResumeResult,
} from '../application/ports/taskAutoResumeCommand'
export {
  createBuildScheduleLaunch,
  createTaskExecutionTriggerParticipant,
  type TaskExecutionTriggerParticipant,
} from './triggerExecution'
export {
  createPostgresqlRepositoryPreparationRetryCommand,
  type PostgresqlRepositoryPreparationRetryDependencies,
} from '../infrastructure/postgresqlRepositoryPreparationRetryCommand'
export {
  createTaskRouteWorkspaceParticipant,
  createTaskWorkspaceMaterializer,
  type TaskRouteWorkspaceDependencies,
  type TaskWorkspaceMaterializer,
  type TaskWorkspacePreparation,
} from '../infrastructure/taskRouteWorkspaceParticipant'
export {
  composePostgresqlTaskExecutionProviderRuntime,
  composeSqliteTaskExecutionProviderRuntime,
  type PostgresqlTaskExecutionProviderRuntimeDependencies,
  type SelectedPostgresqlTaskExecutionProviderRuntime,
  type SelectedSqliteTaskExecutionProviderRuntime,
  type SelectedTaskExecutionProviderRuntime,
  type PostgresqlTaskExecutionRuntimeDependencies,
  type SqliteTaskExecutionProviderRuntimeDependencies,
  type TaskExecutionBackgroundControl,
  type TaskExecutionBackgroundStartDependencies,
  type TaskExecutionProviderRouteContext,
} from './providerRuntime'

// RFC-359 AC-1（plan §5fr）：读模型只有一份实现，三个「具名工厂」曾是它的纯别名再导出
// （W4-B1 留的过渡绑定，注释原文就写着「bootstrap 收敛后一并删」）。bootstrap 已收敛：
// `composeTaskExecutionReadModels` / `composeSqliteTaskExecutionReadModels` 零消费者，
// `composePostgresqlTaskExecutionReadModels` 唯一的消费者是一条测试——它让那条测试**看起来**
// 在测一个 PostgreSQL 专属适配器，而那个东西根本不存在。三个一起删，调用方直接用本名。
export { createTaskExecutionReadModels } from '../infrastructure/taskExecutionReadModels'
// 同上：catalog source 工厂也只有一份实现，`createPostgresqlTaskExecutionCatalogSourceFactory`
// 这个别名唯一的作用是让 PG 组合根那一行读起来「对称」——那是**假的对称**，删。
export { createDatabaseTaskExecutionCatalogSourceFactory } from '../infrastructure/taskCatalogSources'
