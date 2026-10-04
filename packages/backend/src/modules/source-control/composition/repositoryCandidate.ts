// RFC-370 A4 — candidate effects are selected only at composition.
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
} from '../application/deliverCandidate'
import type { RepositoryCandidateEffectsFactory } from '../application/ports/repositoryCandidateEffects'
import type { RepositoryGit } from '../application/repositoryCommit'
import { createFileRepositoryCandidateEffectsFactory } from '../infrastructure/local/fileRepositoryCandidateEffects'
import { createFileRepositoryPublicationFixtureSession } from '../infrastructure/local/fileRepositoryPublicationFixture'
import type { RepositoryPublicationTransport } from '../public/types'

function validateFactory(selected: RepositoryCandidateEffectsFactory | undefined): void {
  if (selected !== undefined && (selected === null || typeof selected.acquire !== 'function')) {
    throw new Error('repository-candidate-effects-incomplete')
  }
}

function selectFactory(
  request: { readonly runGit?: RepositoryGit },
  selected: RepositoryCandidateEffectsFactory | undefined,
): RepositoryCandidateEffectsFactory {
  if (selected !== undefined) return selected
  const runGit = request.runGit
  return createFileRepositoryCandidateEffectsFactory({ runGit })
}

export function bindChangeCandidateParticipant(
  input: { readonly candidateEffects?: RepositoryCandidateEffectsFactory } = {},
) {
  const selected = input.candidateEffects
  validateFactory(selected)
  return {
    derive: (request: DeriveChangeCandidateInput) =>
      deriveChangeCandidate(request, selectFactory(request, selected)),
  }
}

export function bindCandidateDeliveryParticipant(
  input: {
    readonly candidateEffects?: RepositoryCandidateEffectsFactory
    readonly publicationTransport?: RepositoryPublicationTransport
  } = {},
) {
  const selected = input.candidateEffects
  validateFactory(selected)
  return {
    stage: (request: StageCandidateTreeInput) =>
      stageCandidateTree(request, selectFactory(request, selected)),
    commit: (request: CommitCandidateInput) =>
      commitCandidate(request, selectFactory(request, selected)),
    push: (request: Parameters<typeof pushCandidate>[0]) => {
      if (selected !== undefined) {
        return pushCandidate(request, selected, { transport: input.publicationTransport })
      }
      const runGit = request.runGit
      return pushCandidate(request, createFileRepositoryCandidateEffectsFactory({ runGit }), {
        transport: input.publicationTransport,
        localFixtureSession: (remoteUrl) =>
          createFileRepositoryPublicationFixtureSession(remoteUrl, runGit),
      })
    },
  }
}
