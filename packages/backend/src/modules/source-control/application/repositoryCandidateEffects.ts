// RFC-511 — the selected candidate effects are complete: an operation host carries its four operations, a step factory
// can acquire. RFC-527: the selection is required.
import {
  isRepositoryCandidateOperationHost,
  type RepositoryCandidateEffectsFactory,
  type RepositoryCandidateOperationHost,
} from './ports/repositoryCandidateOperations'

export function requireRepositoryCandidateEffectsFactory(
  selected: RepositoryCandidateEffectsFactory,
): void {
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
