import type { OwnCodeHostPushCredentialList } from '@agent-workflow/shared'
import type { OwnRepositoryCredentialSubject } from './types'

export interface OwnRepositoryTransportCredentialQueries {
  list(subject: OwnRepositoryCredentialSubject): OwnCodeHostPushCredentialList
}
