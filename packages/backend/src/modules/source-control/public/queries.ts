import type { OwnCodeHostPushCredentialList } from '@agent-workflow/shared'
import type { OwnRepositoryCredentialSubject } from './types'

export interface OwnRepositoryTransportCredentialQueries {
  list(subject: OwnRepositoryCredentialSubject): Promise<OwnCodeHostPushCredentialList>
}

/** Secret-free system projection; no repository persistence mechanism leaks. */
export interface RepositoryOverviewQueries {
  countCachedRepositories(): Promise<number>
}
