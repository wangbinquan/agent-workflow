import type { OwnCodeHostPushCredentialList } from '@agent-workflow/shared'
import type { ResolvedAuthoritySubject } from '@/modules/identity-access/public/types'

export interface OwnRepositoryTransportCredentialQueries {
  list(subject: ResolvedAuthoritySubject): OwnCodeHostPushCredentialList
}
