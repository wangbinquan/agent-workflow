import { decodeWrapperProgress } from '../domain/wrapperProgress'
import type { Actor } from '@/auth/actor'
import { parseLoopExitCondition, type OverviewTasks } from '@agent-workflow/shared'

export { parseLoopExitCondition } from '@agent-workflow/shared'

// RFC-354 — frame primitives offered to the legacy `services/` pickers and
// predicates (dispatchFrontier / freshness / runLiveness) until they move in.
// Only the symbols a legacy consumer actually reads are public; the rest of
// the environment-chain vocabulary stays inside the context.
export { containerMemberRuns, containerMemberRunsInRound } from '../domain/containerMembership'
export { loadFrameChain, type FrameChain } from '../application/frameChain'
// RFC-359 AC-11：任务可见性判据的 SQL 片段形态。别的上下文（评审徽标等）把它 AND 进
// 自己那一条语句，就不必先捞 taskId 列表再问一次——规则仍归本上下文所有，调用方也
// 不需要 import `task_collaborators` 表。与 `visibleIds` 同一份代码，不可能漂。
export { taskVisibilityCondition } from '../infrastructure/taskAuthorization'
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
