// RFC-370 A4 — candidate effects are selected only at composition.
// RFC-370 §9.2 V3 — a hosted selection is an operation host: each whole use
// case runs in the remote volume instead of one round trip per step.
// RFC-527 — the selection is required: standalone selects the local step factory below, which carries the local
// fixture session its pushes use (no hosted transport or durable subject: local paths and `file://` remotes).
import {
  deriveChangeCandidate,
  stageCandidateTree,
  type DeriveChangeCandidateInput,
  type StageCandidateTreeInput,
} from '../application/changeCandidate'
import {
  commitCandidate,
  pushCandidate,
  type CommitCandidateInput,
  type PushCandidateInput,
} from '../application/deliverCandidate'
import type { RepositoryCandidateStepEffectsFactory } from '../application/ports/repositoryCandidateEffects'
import {
  isRepositoryCandidateOperationHost,
  type RepositoryCandidateEffectsFactory,
} from '../application/ports/repositoryCandidateOperations'
import type { RepositoryGit } from '../application/repositoryCommit'
import { requireRepositoryCandidateEffectsFactory } from '../application/repositoryCandidateEffects'
import { createFileRepositoryCandidateEffectsFactory } from '../infrastructure/local/fileRepositoryCandidateEffects'
import { createFileRepositoryPublicationFixtureSession } from '../infrastructure/local/fileRepositoryPublicationFixture'
import type { RepositoryPublicationTransport } from '../public/types'

/** RFC-527: the standalone selection — local candidate steps whose pushes open the local fixture session. */
export function createLocalRepositoryCandidateEffects(
  input: { readonly runGit?: RepositoryGit } = {},
): RepositoryCandidateStepEffectsFactory {
  const runGit = input.runGit
  return Object.freeze({
    ...createFileRepositoryCandidateEffectsFactory({ runGit }),
    localFixtureSession: (remoteUrl: string) =>
      createFileRepositoryPublicationFixtureSession(remoteUrl, runGit),
  })
}

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
