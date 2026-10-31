export { nodeOutputSlot } from '../domain/runSelection/nodeOutputSlot'
export {
  freezeRuntimeBinaryConfiguration,
  readTaskCommitExcludePatterns,
} from '../application/operationConfiguration'
export {
  forcedPortPathsForTask,
  portArchiveRootRel,
  toContainerRelative,
} from '../application/portArtifacts'
export type { NodeExecutionSnapshot } from '../application/ports/nodeExecutionPersistence'
export type { NodeRunPromptReader } from '../application/ports/nodeRunPromptContent'
export type {
  NodeRunCheckpointSnapshot,
  NodeRunDispatchFacts,
  NodeRunFactSnapshot,
  NodeRunFactsQuery,
  NodeRunQueries,
} from '../application/ports/nodeRunQueries'
export type { PortArtifactReader } from '../application/ports/portArtifactContent'
export type {
  ConsumedEdge,
  FamilyRef,
  Frame,
  HistoryFilter,
  RunRef,
  RunSelectionReader,
  RunSlot,
  SelectedRun,
  ShardRequest,
  ShardSelectionView,
  ShardSetView,
  WrapperSlotRef,
} from '../application/ports/runSelection'
export type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
export { readNodeRunPrompt } from '../composition/nodeRunPrompts'
export { readPortArtifact } from '../composition/portArtifacts'
export { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
export { deriveNodeRunRole } from '../domain/nodeRunRole'
export { ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_AGENT_NAME } from '../domain/orchestratorAgentIdentity'
export {
  encodePortSegment,
  isPathishKindString,
  missingArtifactPlaceholder,
  parseArchiveJson,
  repoRelForcedPaths,
  subsetArchiveJson,
  truncationNotice,
} from '../domain/portArtifacts'
export { aggregatorInputsMatch, compareRunSequence } from '../domain/runSelection/ordering'
export { decodeRunSlot, encodeRunSlot, runSlotsEqual } from '../domain/runSelection/slots'
import { createNodeRunQueries as createNodeRunQueriesInternal } from '../infrastructure/nodeRunQueries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { NodeRunQueries } from '../application/ports/nodeRunQueries'
/** The offered query factory uses the owner's database content reader. Selected stores are composition-only. */
export function createNodeRunQueries(db: PersistenceDb): NodeRunQueries {
  return createNodeRunQueriesInternal(db)
}
export { resolveHandlerRun } from '../application/resolveHandlerRun'
export { createRunHistorySnapshot, createRunHistoryBatchSnapshot } from '../application/runHistory'
export type { RunHistoryFacts } from '../application/runHistory'
export { createRunSelectionReader } from '../infrastructure/runSelection/table/reader'
import type { AuthenticatedAuthoritySnapshot } from '@/modules/identity-access/public/participants'
import type { WorktreeTreeEntry } from '@agent-workflow/shared'
import { parseLoopExitCondition, type OverviewTasks } from '@agent-workflow/shared'
import { decodeWrapperProgress } from '../domain/wrapperProgress'

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
export { loadFrameChain, type FrameChain } from '../application/frameChain'
export { containerMemberRuns, containerMemberRunsInRound } from '../domain/containerMembership'
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
  load(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly since: number
  }): Promise<OverviewTasks>
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

export {
  resolveTaskCommitPushFromReader,
  resolveTaskLaunchRuntimeConfiguration,
  resolveTaskLaunchRuntimeFromReader,
  resolveTaskStartLaunchConfiguration,
  resolveTaskSubagentLiveCapture,
  resolveTaskSubagentLiveCaptureFromReader,
  resolveTaskUploadLimitsFromReader,
} from '../application/launchConfiguration'
export type { TaskLaunchConfigurationQueries } from '../application/ports/taskLaunchConfiguration'

export { resolveUniqueUploadNameSync } from '../application/workspaceUploads'
export {
  acceptMatches,
  DEFAULT_UPLOAD_LIMITS,
  sniffMime,
  validateUploadPlan,
} from '../domain/uploads'

export { createTaskSubjectQueries } from '../composition/taskSubjectQueries'
export {
  definitionAnchorId,
  definitionHost,
  isTurnEngineTaskSubject,
  projectTaskSubject,
  TASK_DEFINITION_HOSTS,
  taskDefinitionOrigin,
  taskSubjectFromDefinition,
  taskSubjectWorkflowVersion,
} from '../domain/taskSubject'

export { repositoryPublicationOrdinal } from '../domain/repositoryExecutionIdentity'
export { inheritTaskPreSnapshots } from '../domain/taskCheckpoint'

export { hasTaskRollbackCheckpoint } from '../domain/taskCheckpointRollback'
/** RFC-395 II-a：节点回滚计划（逐仓目标 + 持久化请求），legacy `services/nodeRollback.ts` 经此取用。 */
export { taskRollbackPlan } from '../infrastructure/taskRollbackCodec'

export { taskRepositoryNodePaths } from '../domain/taskRepository'
export { projectStoredTaskRepositorySummary } from '../infrastructure/taskRepositorySurface'

export { decodeTaskWorkgroupConfig, workgroupLaunchMode } from '../domain/taskWorkgroupConfig'
export { decodeTaskRepositoryMount } from '../infrastructure/taskRepositoryCodec'
export { taskWorkgroupConfigFromRow } from '../infrastructure/taskWorkgroupConfig'

export {
  consumedEdgesFromRecord,
  decodeConsumedEdges,
  encodeConsumedEdges,
  parseConsumedJson,
} from '../infrastructure/runSelection/consumedCodec'

export { nodeRunStatusCondition } from '../infrastructure/nodeRunQueries'

export type { NodeOutputContent, NodeOutputQueries } from '../application/ports/nodeOutputQueries'
export type {
  TaskDispatchContext,
  TaskGateContext,
  TaskGateDefinitionContext,
  TaskGateQueries,
} from '../application/ports/taskGateQueries'
export { createNodeOutputQueries } from '../infrastructure/nodeOutputQueries'
export { createTaskGateQueries } from '../infrastructure/taskGateQueries'

export { taskGateOpenCondition, taskGateVisibleCondition } from '../infrastructure/taskGateQueries'

export { createTaskKnowledgeQueries } from '../infrastructure/taskKnowledgeQueries'
export { createTaskTriggerQueries } from '../infrastructure/taskTriggerQueries'

export { listNodeEventContents, type NodeEventContent } from '../infrastructure/nodeEventQueries'

export type {
  TaskDistillationScope,
  TaskDistillationSource,
  TaskKnowledgeContext,
  TaskKnowledgeQueries,
} from '../application/ports/taskKnowledgeQueries'
export type {
  TaskTerminalWorkspace,
  TaskTriggerQueries,
} from '../application/ports/taskTriggerQueries'

export type { TaskDeletionQueries } from '../application/ports/taskDeletion'
export { createTaskDeletionQueries } from '../infrastructure/taskDeletionQueries'

export type { TaskDetailQueries } from '../application/ports/taskDetailQueries'
export type { TaskPreparationQueries } from '../application/ports/taskPreparation'
export { createTaskDetailQueries } from '../infrastructure/taskDetailQueries'
export { createTaskPreparationQueries } from '../infrastructure/taskPreparationQueries'

export type {
  TaskWorktreeLocation,
  TaskWorktreeLocator,
} from '../application/ports/taskWorktreeLocator'

export { callRowHumanWait, readTaskResourceUsage } from '../application/taskResourceUsage'
export { parseCallHumanWait } from '../domain/resourceLimitUsage'
export { nonTerminalTaskExists } from '../infrastructure/nonTerminalTaskExists'

export { requireRunSequence } from '../application/runHistory'

export {
  buildFreshestSettledPerNode,
  isNodeRunFresh,
  consumedMapsEqual,
} from '../application/runProvenance'

export type { NodeRunRow } from '../application/runProvenance'

export { nextRetryIndex } from '../application/nextRetryIndex'
