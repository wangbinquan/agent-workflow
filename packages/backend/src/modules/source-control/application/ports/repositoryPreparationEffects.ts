import type { RepositoryPreparationFacts } from '../../domain/repositoryPreparationFacts'
import type { RepositoryPreparationSafeCode } from '../../public/types'
import type { GitCommitIdentity } from '@agent-workflow/shared'
import type { RepositoryPreparationOperationRef } from '../../public/types'
import type { RepositoryPreparationCleanupEffects } from '../repositoryPreparationCleanup'

/** SC-private codecs own these serialized physical records; application never interprets paths. */
export type RepositoryPreparationEffectFailure = {
  readonly kind: 'failed'
  readonly safeCode: RepositoryPreparationSafeCode
  readonly diagnosticsJson: string
}
export interface RepositoryPreparationEffects {
  /** Bound to the existing Task attempt/launch fence. No SC lease is acquired. */
  assertCurrent(): Promise<void>
  resolveCommits(
    facts: RepositoryPreparationFacts,
  ): Promise<
    | { readonly kind: 'resolved'; readonly planJson: string }
    | { readonly kind: 'stopped'; readonly receiptJson: string }
    | RepositoryPreparationEffectFailure
  >
  materialize(input: {
    readonly planJson: string
    readonly evidenceJson: string | null
    readonly checkpoint: (evidenceJson: string) => Promise<void>
  }): Promise<
    | { readonly kind: 'prepared'; readonly receiptJson: string }
    | { readonly kind: 'stopped'; readonly receiptJson: string }
    | RepositoryPreparationEffectFailure
  >
}

/** One operation-bound effect set is shared by preparation and compensation.
 * Local paths, Git processes and transport credentials stay in the adapter. */
export interface RepositoryPreparationEffectFactory {
  create(input: {
    readonly taskId: string
    readonly operationRef: RepositoryPreparationOperationRef
    readonly workingBranch?: string
    readonly gitCommitIdentity: GitCommitIdentity | null
    readonly signal: AbortSignal
    readonly assertCurrent: () => Promise<void>
  }):
    | (RepositoryPreparationEffects & RepositoryPreparationCleanupEffects)
    | Promise<RepositoryPreparationEffects & RepositoryPreparationCleanupEffects>
}
