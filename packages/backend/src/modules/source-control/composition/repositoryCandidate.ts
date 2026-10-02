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
import type { RepositoryPublicationTransport } from '../public/types'

function selectFactory(
  request: { readonly runGit?: RepositoryGit },
  selected: RepositoryCandidateEffectsFactory | undefined,
): RepositoryCandidateEffectsFactory {
  return selected ?? createFileRepositoryCandidateEffectsFactory({ runGit: request.runGit })
}

export function bindChangeCandidateParticipant(
  input: { readonly candidateEffects?: RepositoryCandidateEffectsFactory } = {},
) {
  return {
    derive: (request: DeriveChangeCandidateInput) =>
      deriveChangeCandidate(request, selectFactory(request, input.candidateEffects)),
  }
}

export function bindCandidateDeliveryParticipant(
  input: {
    readonly candidateEffects?: RepositoryCandidateEffectsFactory
    readonly publicationTransport?: RepositoryPublicationTransport
  } = {},
) {
  return {
    stage: (request: StageCandidateTreeInput) =>
      stageCandidateTree(request, selectFactory(request, input.candidateEffects)),
    commit: (request: CommitCandidateInput) =>
      commitCandidate(request, selectFactory(request, input.candidateEffects)),
    push: (request: Parameters<typeof pushCandidate>[0]) =>
      pushCandidate({
        ...request,
        ...(input.publicationTransport === undefined
          ? {}
          : { publicationTransport: input.publicationTransport }),
      }),
  }
}
