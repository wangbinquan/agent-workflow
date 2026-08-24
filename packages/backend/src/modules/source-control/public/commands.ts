import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialSummary,
  PutOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import type { ResolvedAuthoritySubject } from '@/modules/identity-access/public/types'

export interface OwnRepositoryTransportCredentialCommands {
  put(
    subject: ResolvedAuthoritySubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): OwnCodeHostPushCredentialSummary
  remove(
    subject: ResolvedAuthoritySubject,
    provider: CodeHostProvider,
  ): { readonly removed: boolean }
}
