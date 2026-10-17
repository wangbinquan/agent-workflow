// RFC-370 §9.2 V3 — where the candidate use cases execute.
//
// Standalone runs each use case in this process over per-step effects. A
// hosted deployment keeps candidate workspaces in a remote task volume: there
// each whole use case is ONE operation that calls the same application
// function with the volume's native step effects, instead of one remote round
// trip per file or Git step.
import type {
  DeriveChangeCandidateInput,
  DeriveChangeCandidateResult,
  StageCandidateTreeInput,
  StageCandidateTreeResult,
} from '../changeCandidate'
import type {
  CommitCandidateInput,
  CommitCandidateResult,
  PushCandidateInput,
  PushCandidateResult,
} from '../deliverCandidate'
import type { RepositoryCandidateStepEffectsFactory } from './repositoryCandidateEffects'

export interface RepositoryCandidateOperations {
  derive(input: DeriveChangeCandidateInput): Promise<DeriveChangeCandidateResult>
  /** The staged tree stays in the workspace's environment until `cleanup`. */
  stage(input: StageCandidateTreeInput): Promise<StageCandidateTreeResult>
  commit(input: CommitCandidateInput): Promise<CommitCandidateResult>
  /** Publishes with the environment's own Git credentials; an in-process
   * publication transport does not cross into a remote volume. */
  push(input: PushCandidateInput): Promise<PushCandidateResult>
}

export interface RepositoryCandidateOperationHost {
  readonly operations: RepositoryCandidateOperations
}

/** The deployment's candidate selection: in-process per-step effects, or a
 * host that runs each whole use case where the workspace lives. */
export type RepositoryCandidateEffectsFactory =
  | RepositoryCandidateStepEffectsFactory
  | RepositoryCandidateOperationHost

export function isRepositoryCandidateOperationHost(
  selected: RepositoryCandidateEffectsFactory,
): selected is RepositoryCandidateOperationHost {
  return 'operations' in selected
}
