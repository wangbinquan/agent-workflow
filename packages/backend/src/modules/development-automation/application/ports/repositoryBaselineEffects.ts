import type { RepositoryCandidateGitOutcome } from '@/modules/source-control/public/types'
import type { BaselineFileReader } from '../uploadPlan'

type Completion<T> = T | Promise<T>

/** One complete baseline scope. Reader calls finish before the scope closes. */
export interface RepositoryBaselineEffects {
  readHead(repositoryReference: string): Completion<RepositoryCandidateGitOutcome>
  bindFileReader(repositoryReference: string, baselineSha: string): Completion<BaselineFileReader>
  close(): Completion<void>
}

export interface RepositoryBaselineEffectsFactory {
  acquire(): Completion<RepositoryBaselineEffects>
}
