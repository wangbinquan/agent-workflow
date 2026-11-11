export { nodeOutputSlot } from '../domain/runSelection/nodeOutputSlot'
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
  FamilyRef,
  Frame,
  HistoryFilter,
  RunRef,
  RunSlot,
  SelectedRun,
  ShardSetView,
} from '../application/ports/runSelection'
export { isPathishKindString, subsetArchiveJson } from '../domain/portArtifacts'
// RFC-453: the node-run timeline order (review rows by their round anchor) for workspace-insight's node scope.
export { compareNodeRunsForTimeline } from '../application/reviewRoundTiming'
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
import { type OverviewTasks } from '@agent-workflow/shared'
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

// RFC-354 — frame primitives offered to the legacy `services/` pickers and
// predicates (dispatchFrontier / freshness / runLiveness) until they move in.
// Only the symbols a legacy consumer actually reads are public; the rest of
// the environment-chain vocabulary stays inside the context.
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
  load(input: {
    readonly actor: AuthenticatedAuthoritySnapshot
    readonly since: number
  }): Promise<OverviewTasks>
}

/** Public projection of the baseline carried by a persisted git-wrapper row. */
export function readWrapperGitBaseline(progressJson: string | null | undefined): string | null {
  const progress = decodeWrapperProgress(progressJson, () => {})
  if (progress?.kind !== 'git') return null
  return progress.baseline !== undefined && progress.baseline !== '' ? progress.baseline : null
}

// RFC-478：`createRunHistoryBatchSnapshot`、`resolveTaskLaunchRuntimeConfiguration`、`TaskLaunchConfigurationQueries`、
// `createTaskDetailQueries` 与 `createTaskPreparationQueries` 模块外唯一的生产读者是 `services/task.ts`，它退役后撤出（本模块改取定义处）。

export { createTaskSubjectQueries } from '../composition/taskSubjectQueries'
export { isTurnEngineTaskSubject, taskSubjectFromDefinition } from '../domain/taskSubject'

export { hasTaskRollbackCheckpoint } from '../domain/taskCheckpointRollback'
/** RFC-477: single-agent launch payload validation (integration's scheduled tasks validate the same shape). */
export { validateAgentLaunchShape } from '../domain/agentHostWorkflow'
// RFC-395 II-a 的节点回滚计划（`taskRollbackPlan`）此前从这里出去，只因 legacy 的 `services/nodeRollback.ts` 不得
// import 模块内部；RFC-477 把回滚迁进 task-execution（`infrastructure/nodeRollback.ts`），它改取定义处，这一项撤出 public。

export { parseConsumedJson } from '../infrastructure/runSelection/consumedCodec'

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

export { nextRetryIndex } from '../application/nextRetryIndex'
