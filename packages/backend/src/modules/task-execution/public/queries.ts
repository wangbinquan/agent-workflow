import { decodeWrapperProgress } from '../domain/wrapperProgress'
import type { Actor } from '@/auth/actor'
import { parseLoopExitCondition, type OverviewTasks } from '@agent-workflow/shared'

export { parseLoopExitCondition } from '@agent-workflow/shared'

/**
 * Task Execution owns the public-task window used by System Overview.  The
 * adapter applies the exact owner/collaborator visibility rule and never
 * exposes a provider row or client to the aggregate.
 */
export interface TaskOverviewQuery {
  load(input: { readonly actor: Actor; readonly since: number }): Promise<OverviewTasks>
}

/**
 * Public read of the loop iteration used by parked-wrapper revival. Malformed
 * or absent progress retains the runtime's historical iteration-zero fallback.
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
