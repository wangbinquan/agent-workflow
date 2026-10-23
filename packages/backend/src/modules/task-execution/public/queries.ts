export { createNodeRunQueries } from '../infrastructure/nodeRunQueries'
export type {
  NodeRunQueries,
  NodeRunFactsQuery,
  NodeRunFactSnapshot,
  NodeRunCheckpointSnapshot,
  NodeRunDispatchFacts,
} from '../application/ports/nodeRunQueries'
export type { NodeExecutionSnapshot } from '../application/ports/nodeExecutionPersistence'
export type { RunHistoryFacts } from '../infrastructure/runSelection/oracle/historySnapshot'
export { createRunHistorySnapshot } from '../infrastructure/runSelection/oracle/historySnapshot'
export { resolveHandlerRun } from '../infrastructure/runSelection/oracle/handlerHistory'
export { readPortArtifact } from '../composition/portArtifacts'
export type {
  RunSelectionReader,
  RunRef,
  SelectedRun,
  RunSlot,
  Frame,
  FamilyRef,
  HistoryFilter,
  WrapperSlotRef,
  ShardSetView,
  ShardSelectionView,
  ShardRequest,
  ConsumedEdge,
} from '../application/ports/runSelection'
export { createRunSelectionReader } from '../infrastructure/runSelection/oracle/reader'
export { createRunSelectionOracleSnapshot } from '../infrastructure/runSelection/oracle/snapshot'
export { encodeRunSlot, decodeRunSlot, runSlotsEqual } from '../domain/runSelection/slots'
export { compareRunSequence, aggregatorInputsMatch } from '../domain/runSelection/ordering'
export { deriveNodeRunRole } from '../domain/nodeRunRole'
export { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
export type { PortArtifactReader } from '../application/ports/portArtifactContent'
export {
  encodePortSegment,
  repoRelForcedPaths,
  parseArchiveJson,
  truncationNotice,
  isPathishKindString,
  missingArtifactPlaceholder,
  subsetArchiveJson,
} from '../domain/portArtifacts'
export {
  forcedPortPathsForTask,
  portArchiveRootRel,
  toContainerRelative,
} from '../application/portArtifacts'
export { readNodeRunPrompt } from '../composition/nodeRunPrompts'
export type { NodeRunPromptReader } from '../application/ports/nodeRunPromptContent'
import { decodeWrapperProgress } from '../domain/wrapperProgress'
export { ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_AGENT_NAME } from '../domain/orchestratorAgentIdentity'
export type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
export {
  freezeRuntimeBinaryConfiguration,
  readTaskCommitExcludePatterns,
} from '../application/operationConfiguration'
import type { Actor } from '@/auth/actor'
import { parseLoopExitCondition, type OverviewTasks } from '@agent-workflow/shared'
import type { WorktreeTreeEntry } from '@agent-workflow/shared'

/** The existing Task visibility gate runs before these bound workspace queries. */
export interface TaskWorkspaceQueries {
  listDisplay(
    taskId: string,
    relativeDirectory: string,
  ): Promise<{ readonly entries: readonly WorktreeTreeEntry[]; readonly truncated: boolean }>
  readDisplay(
    taskId: string,
    relativeFile: string,
  ): Promise<{ readonly content: string; readonly size: number; readonly oversized: boolean }>
}

export { parseLoopExitCondition } from '@agent-workflow/shared'

// RFC-354 — frame primitives offered to the legacy `services/` pickers and
// predicates (dispatchFrontier / freshness / runLiveness) until they move in.
// Only the symbols a legacy consumer actually reads are public; the rest of
// the environment-chain vocabulary stays inside the context.
export { containerMemberRuns, containerMemberRunsInRound } from '../domain/containerMembership'
export { loadFrameChain, type FrameChain } from '../application/frameChain'
export {
  resolveSourceFrame,
  type ContainerRunRow,
  type FrameCoordinate,
  type SourceFrameResolution,
} from '../domain/environmentChain'

/**
 * Task Execution owns the public-task window used by System Overview.  The
 * adapter applies the exact owner/collaborator visibility rule and never
 * exposes a provider row or client to the aggregate.
 */
export interface TaskOverviewQuery {
  load(input: { readonly actor: Actor; readonly since: number }): Promise<OverviewTasks>
}

/**
 * The loop round a parked wrapper-loop generation was driving when it parked:
 * the frame its revival evidence must sit in. Malformed or absent progress
 * retains the runtime's historical round-zero fallback.
 */
export function readWrapperRevivalIteration(progressJson: string | null | undefined): number {
  return decodeWrapperProgress(progressJson, () => {})?.iteration ?? 0
}

/** Public projection of the baseline carried by a persisted git-wrapper row. */
export function readWrapperGitBaseline(progressJson: string | null | undefined): string | null {
  const progress = decodeWrapperProgress(progressJson, () => {})
  if (progress?.kind !== 'git') return null
  return progress.baseline !== undefined && progress.baseline !== '' ? progress.baseline : null
}

/** Closed candidate vocabulary accepted by the validator before exact parsing. */
export interface LoopExitConditionCandidate {
  readonly kind?: string
  readonly nodeId?: string
  readonly portName?: string
  readonly value?: string
  readonly n?: number
  readonly separator?: string
}

/** Validator-facing interpretation of the runtime's exact loop-exit grammar. */
export function isValidLoopExitCondition(value: LoopExitConditionCandidate): boolean {
  return parseLoopExitCondition(value) !== null
}

export type { TaskLaunchConfigurationQueries } from '../application/ports/taskLaunchConfiguration'
export {
  resolveTaskCommitPushFromReader,
  resolveTaskLaunchRuntimeFromReader,
  resolveTaskLaunchRuntimeConfiguration,
  resolveTaskStartLaunchConfiguration,
  resolveTaskSubagentLiveCapture,
  resolveTaskSubagentLiveCaptureFromReader,
  resolveTaskUploadLimitsFromReader,
} from '../application/launchConfiguration'

export {
  DEFAULT_UPLOAD_LIMITS,
  sniffMime,
  acceptMatches,
  validateUploadPlan,
} from '../domain/uploads'
export { resolveUniqueUploadNameSync } from '../application/workspaceUploads'

export {
  decodeTaskSubject,
  isTurnEngineTaskSubject,
  definitionAnchorId,
  definitionHost,
  projectTaskSubject,
  taskDefinitionOrigin,
  taskSubjectWorkflowVersion,
  TASK_DEFINITION_HOSTS,
} from '../domain/taskSubject'
export { createTaskSubjectQueries } from '../composition/taskSubjectQueries'

export {
  decodeTaskRollbackCheckpoints,
  projectTaskCheckpoints,
} from '../infrastructure/taskCheckpointCodec'
export { inheritTaskPreSnapshots } from '../domain/taskCheckpoint'
export { repositoryPublicationOrdinal } from '../domain/repositoryExecutionIdentity'

export { hasTaskRollbackCheckpoint } from '../domain/taskCheckpointRollback'
/** RFC-395 II-a：节点回滚计划（逐仓目标 + 持久化请求），legacy `services/nodeRollback.ts` 经此取用。 */
export { taskRollbackPlan } from '../infrastructure/taskRollbackCodec'

export { projectStoredTaskRepositorySummary } from '../infrastructure/taskRepositorySurface'
export { taskRepositoryNodePaths } from '../domain/taskRepository'

export { decodeTaskWorkgroupConfig, workgroupLaunchMode } from '../domain/taskWorkgroupConfig'
export { decodeTaskRepositoryMount } from '../infrastructure/taskRepositoryCodec'
export { taskWorkgroupConfigFromRow } from '../infrastructure/taskWorkgroupConfig'

export {
  isFresherNodeRun,
  pickLatestSettledRun,
  pickLatestRunInFrame,
  pickFrameSourceRun,
  isSettledRunStatus,
  pickReusableShardRun,
  pickFreshestRun,
} from '../infrastructure/runSelection/oracle/legacyPickers'
export {
  parseConsumedJson,
  decodeConsumedEdges,
  encodeConsumedEdges,
  consumedEdgesFromRecord,
} from '../infrastructure/runSelection/consumedCodec'

export { nodeRunStatusCondition } from '../infrastructure/nodeRunQueries'

export { createTaskGateQueries } from '../infrastructure/taskGateQueries'
export type {
  TaskGateQueries,
  TaskGateContext,
  TaskGateDefinitionContext,
  TaskDispatchContext,
} from '../application/ports/taskGateQueries'
export { createNodeOutputQueries } from '../infrastructure/nodeOutputQueries'
export type { NodeOutputQueries, NodeOutputContent } from '../application/ports/nodeOutputQueries'

export { taskGateOpenCondition, taskGateVisibleCondition } from '../infrastructure/taskGateQueries'

export { createTaskKnowledgeQueries } from '../infrastructure/taskKnowledgeQueries'
export { createTaskTriggerQueries } from '../infrastructure/taskTriggerQueries'

export { listNodeEventContents, type NodeEventContent } from '../infrastructure/nodeEventQueries'

export type {
  TaskKnowledgeQueries,
  TaskKnowledgeContext,
  TaskDistillationScope,
  TaskDistillationSource,
} from '../application/ports/taskKnowledgeQueries'
export type {
  TaskTriggerQueries,
  TaskTerminalWorkspace,
} from '../application/ports/taskTriggerQueries'

export { createTaskDeletionQueries } from '../infrastructure/taskDeletionQueries'
export type { TaskDeletionQueries } from '../application/ports/taskDeletion'

export { createTaskDetailQueries } from '../infrastructure/taskDetailQueries'
export type { TaskDetailQueries } from '../application/ports/taskDetailQueries'
export { createTaskPreparationQueries } from '../infrastructure/taskPreparationQueries'
export type { TaskPreparationQueries } from '../application/ports/taskPreparation'
