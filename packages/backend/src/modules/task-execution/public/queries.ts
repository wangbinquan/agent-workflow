export { readPortArtifact } from '../composition/portArtifacts'
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
export type { TaskOperationConfigurationQueries } from '../application/ports/taskOperationConfiguration'
export {
  freezeRuntimeBinaryConfiguration,
  readTaskCommitExcludePatterns,
} from '../application/operationConfiguration'
import type { Actor } from '@/auth/actor'
import type { ObservationNativeScopeSource } from '@/modules/run-observability/public/participants'
import { parseLoopExitCondition, type OverviewTasks } from '@agent-workflow/shared'
import type { WorktreeTreeEntry } from '@agent-workflow/shared'
import type {
  ObservationAttemptFacts,
  ObservationTaskFacts,
  ObservationTaskPageQuery,
  ObservationSourceBacklog,
  ObservationSpanSourceInput,
  ObservationSpanSourcePage,
} from '@agent-workflow/shared'

/** RFC-371: actor-filtered execution facts, without runtime payloads or private rows. */
export interface TaskObservationFactsQuery {
  readonly nativeScopes?: ObservationNativeScopeSource
  /** Retained span metadata, after the original actor-visible task lookup. */
  spanSources?(input: ObservationSpanSourceInput): Promise<ObservationSpanSourcePage>
  list(input: { readonly actor: Actor; readonly query: ObservationTaskPageQuery }): Promise<{
    readonly items: readonly ObservationTaskFacts[]
    /** Opaque owner continuations for each authorized item, from this same query. */
    readonly positions: readonly { readonly taskId: string; readonly cursor: string }[]
    readonly nextCursor: string | null
  }>
  get(actor: Actor, taskId: string): Promise<ObservationTaskFacts | null>
  /** Only task IDs supplied by get/list in this same visible snapshot. */
  sourceBacklog(taskIds: readonly string[]): Promise<readonly ObservationSourceBacklog[]>
  /** Called only after get/list supplied this visible task, inside the same read snapshot. */
  /** Original owner keyset pages; consume every continuation to null in the same snapshot. */
  attemptPage?(
    taskId: string,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{
    readonly items: readonly ObservationAttemptFacts[]
    readonly nextCursor: string | null
  }>
  attempts(
    taskId: string,
    limit: number,
  ): Promise<{
    readonly items: readonly ObservationAttemptFacts[]
    readonly truncated: boolean
  }>
}

/** Original retained Task/System IDs, qualified by their owner on the supplied reader. */
export interface CompleteTaskObservationFactsQuery extends TaskObservationFactsQuery {
  visibleIds(actor: Actor, sourceIds: readonly string[]): Promise<readonly string[]>
}

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
