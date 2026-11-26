// RFC-622 — the two candidate participants the deployment's selected candidate effects drive, moved unchanged from
// `composition/repositoryCandidate.ts`. Which surface runs a use case — the hosted operation host (one remote operation per
// whole use case, RFC-370 §9.2 V3) or the local step factory — is use-case orchestration, so it lives in application;
// composition only assembles the selection (RFC-527: the selection itself is required).
import {
  deriveChangeCandidate,
  stageCandidateTree,
  type DeriveChangeCandidateInput,
  type StageCandidateTreeInput,
} from './changeCandidate'
import {
  commitCandidate,
  pushCandidate,
  type CommitCandidateInput,
  type PushCandidateInput,
} from './deliverCandidate'
import {
  isRepositoryCandidateOperationHost,
  type RepositoryCandidateEffectsFactory,
} from './ports/repositoryCandidateOperations'
import { requireRepositoryCandidateEffectsFactory } from './repositoryCandidateEffects'
import type { RepositoryPublicationTransport } from '../public/types'

export function bindChangeCandidateParticipant(input: {
  readonly candidateEffects: RepositoryCandidateEffectsFactory
}): { derive: (request: DeriveChangeCandidateInput) => ReturnType<typeof deriveChangeCandidate> } {
  const selected = input.candidateEffects
  requireRepositoryCandidateEffectsFactory(selected)
  if (isRepositoryCandidateOperationHost(selected)) {
    const { operations } = selected
    return { derive: (request) => operations.derive(request) }
  }
  return { derive: (request) => deriveChangeCandidate(request, selected) }
}

export function bindCandidateDeliveryParticipant(input: {
  readonly candidateEffects: RepositoryCandidateEffectsFactory
  readonly publicationTransport?: RepositoryPublicationTransport
}): {
  stage: (request: StageCandidateTreeInput) => ReturnType<typeof stageCandidateTree>
  commit: (request: CommitCandidateInput) => ReturnType<typeof commitCandidate>
  push: (request: PushCandidateInput) => ReturnType<typeof pushCandidate>
} {
  const selected = input.candidateEffects
  requireRepositoryCandidateEffectsFactory(selected)
  if (isRepositoryCandidateOperationHost(selected)) {
    // The remote volume runs each whole use case and publishes with its own platform Git credentials.
    const { operations } = selected
    return {
      stage: (request) => operations.stage(request),
      commit: (request) => operations.commit(request),
      push: (request) => operations.push(request),
    }
  }
  const steps = selected
  const publication = {
    transport: input.publicationTransport,
    ...(steps.localFixtureSession === undefined
      ? {}
      : { localFixtureSession: steps.localFixtureSession }),
  }
  return {
    stage: (request) => stageCandidateTree(request, steps),
    commit: (request) => commitCandidate(request, steps),
    push: (request) => pushCandidate(request, steps, publication),
  }
}
