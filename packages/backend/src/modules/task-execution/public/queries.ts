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
// RFC-453: the node-run timeline order (review rows by their round anchor) for workspace-insight's node scope.
export { compareNodeRunsForTimeline } from '../application/reviewRoundTiming'
export { decodeRunSlot, encodeRunSlot, runSlotsEqual } from '../domain/runSelection/slots'
import { createNodeRunQueries as createNodeRunQueriesInternal } from '../infrastructure/nodeRunQueries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { NodeRunQueries } from '../application/ports/nodeRunQueries'
/** The offered query factory uses the owner's database content reader. Selected stores are composition-only. */
export function createNodeRunQueries(db: PersistenceDb): NodeRunQueries {
  return createNodeRunQueriesInternal(db)
}
export { resolveHandlerRun } from '../application/resolveHandlerRun'
export { createRunHistorySnapshot } from '../application/runHistory'
export type { RunHistoryFacts } from '../application/runHistory'
export { createRunSelectionReader } from '../infrastructure/runSelection/table/reader'
import type { AuthenticatedAuthoritySnapshot } from '@/modules/identity-access/public/participants'
import type { WorktreeTreeEntry } from '@agent-workflow/shared'
import {
  parseLoopExitCondition,
  type OverviewTasks,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { decodeWrapperProgress } from '../domain/wrapperProgress'
import { wrapperInnerDescendants } from '../domain/wrapperGraph'

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

// RFC-409: the revival-round read moved to the domain (the DAG scope's frontier rules read it there).
export { readWrapperRevivalIteration } from '../domain/wrapperProgress'

/**
 * RFC-409 — the definition-only inner descendants of a wrapper (direct members and every nested
 * wrapper's members), for the run-liveness report.
 */
export function wrapperInnerDescendantIds(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
): ReadonlySet<string> {
  return wrapperInnerDescendants(wrapperNodeId, definition)
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
  resolveTaskLaunchRuntimeFromReader,
  resolveTaskStartLaunchConfiguration,
  resolveTaskSubagentLiveCapture,
  resolveTaskSubagentLiveCaptureFromReader,
  resolveTaskUploadLimitsFromReader,
} from '../application/launchConfiguration'
// RFC-478：`createRunHistoryBatchSnapshot`、`resolveTaskLaunchRuntimeConfiguration`、`TaskLaunchConfigurationQueries`、
// `createTaskDetailQueries` 与 `createTaskPreparationQueries` 模块外唯一的生产读者是 `services/task.ts`，它退役后撤出（本模块改取定义处）。

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

export { inheritTaskPreSnapshots } from '../domain/taskCheckpoint'

export { hasTaskRollbackCheckpoint } from '../domain/taskCheckpointRollback'
/** RFC-477: single-agent launch payload validation (integration's scheduled tasks validate the same shape). */
export { validateAgentLaunchShape } from '../domain/agentHostWorkflow'
// RFC-395 II-a 的节点回滚计划（`taskRollbackPlan`）此前从这里出去，只因 legacy 的 `services/nodeRollback.ts` 不得
// import 模块内部；RFC-477 把回滚迁进 task-execution（`infrastructure/nodeRollback.ts`），它改取定义处，这一项撤出 public。

export { taskRepositoryNodePaths } from '../domain/taskRepository'
export { projectStoredTaskRepositorySummary } from '../infrastructure/taskRepositorySurface'

export { decodeTaskWorkgroupConfig } from '../domain/taskWorkgroupConfig'
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

// RFC-478：两个查询工厂撤出后，它们的返回类型 `TaskDetailQueries` / `TaskPreparationQueries` 也没有模块外读者，一并撤出。

export type {
  TaskWorktreeLocation,
  TaskWorktreeLocator,
} from '../application/ports/taskWorktreeLocator'

// RFC-477: `callRowHumanWait` / `readTaskResourceUsage` / `parseCallHumanWait` left public with their only outside
// consumer — the resource-limit policy, now task-execution's `application/resourceLimitEnforcement.ts`.
export { nonTerminalTaskExists } from '../infrastructure/nonTerminalTaskExists'

export { requireRunSequence } from '../application/runHistory'

export {
  buildFreshestSettledPerNode,
  isNodeRunFresh,
  consumedMapsEqual,
} from '../application/runProvenance'

export type { NodeRunRow } from '../application/runProvenance'

export { nextRetryIndex } from '../application/nextRetryIndex'
