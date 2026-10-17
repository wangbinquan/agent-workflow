// RFC-370 A4 — candidate effects are selected only at composition.
// RFC-370 §9.2 V3 — a hosted selection is an operation host: each whole use
// case runs in the remote volume instead of one round trip per step.
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
import type { RepositoryCandidateStepEffectsFactory } from '../application/ports/repositoryCandidateEffects'
import {
  isRepositoryCandidateOperationHost,
  type RepositoryCandidateEffectsFactory,
  type RepositoryCandidateOperationHost,
} from '../application/ports/repositoryCandidateOperations'
import type { RepositoryGit } from '../application/repositoryCommit'
import { createFileRepositoryCandidateEffectsFactory } from '../infrastructure/local/fileRepositoryCandidateEffects'
import { createFileRepositoryPublicationFixtureSession } from '../infrastructure/local/fileRepositoryPublicationFixture'
import type { RepositoryPublicationTransport } from '../public/types'

function validateFactory(selected: RepositoryCandidateEffectsFactory | undefined): void {
  if (selected === undefined) return
  if (selected === null || typeof selected !== 'object')
    throw new Error('repository-candidate-effects-incomplete')
  if (isRepositoryCandidateOperationHost(selected)) {
    const operations = selected.operations as Partial<
      RepositoryCandidateOperationHost['operations']
    >
    if (
      operations === null ||
      typeof operations !== 'object' ||
      typeof operations.derive !== 'function' ||
      typeof operations.stage !== 'function' ||
      typeof operations.commit !== 'function' ||
      typeof operations.push !== 'function'
    )
      throw new Error('repository-candidate-effects-incomplete')
    return
  }
  if (typeof selected.acquire !== 'function')
    throw new Error('repository-candidate-effects-incomplete')
}

function hostOf(
  selected: RepositoryCandidateEffectsFactory | undefined,
): RepositoryCandidateOperationHost | undefined {
  return selected !== undefined && isRepositoryCandidateOperationHost(selected)
    ? selected
    : undefined
}

function selectFactory(
  request: { readonly runGit?: RepositoryGit },
  selected: RepositoryCandidateStepEffectsFactory | undefined,
): RepositoryCandidateStepEffectsFactory {
  if (selected !== undefined) return selected
  const runGit = request.runGit
  return createFileRepositoryCandidateEffectsFactory({ runGit })
}

export function bindChangeCandidateParticipant(
  input: { readonly candidateEffects?: RepositoryCandidateEffectsFactory } = {},
) {
  const selected = input.candidateEffects
  validateFactory(selected)
  const host = hostOf(selected)
  const steps =
    host === undefined ? (selected as RepositoryCandidateStepEffectsFactory | undefined) : undefined
  return {
    derive: (request: DeriveChangeCandidateInput) =>
      host !== undefined
        ? host.operations.derive(request)
        : deriveChangeCandidate(request, selectFactory(request, steps)),
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
  const host = hostOf(selected)
  const steps =
    host === undefined ? (selected as RepositoryCandidateStepEffectsFactory | undefined) : undefined
  return {
    stage: (request: StageCandidateTreeInput) =>
      host !== undefined
        ? host.operations.stage(request)
        : stageCandidateTree(request, selectFactory(request, steps)),
    commit: (request: CommitCandidateInput) =>
      host !== undefined
        ? host.operations.commit(request)
        : commitCandidate(request, selectFactory(request, steps)),
    push: (request: Parameters<typeof pushCandidate>[0]) => {
      // The remote volume publishes with its own platform Git credentials.
      if (host !== undefined) return host.operations.push(request)
      if (steps !== undefined) {
        return pushCandidate(request, steps, { transport: input.publicationTransport })
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
