import type { RepositoryPreparationLookup } from '@/modules/task-execution/composition/required-ports'

export function composeRepositoryPreparationLookup(
  source: RepositoryPreparationLookup,
): RepositoryPreparationLookup {
  return { findLocalPath: (cachedRepoId) => source.findLocalPath(cachedRepoId) }
}
