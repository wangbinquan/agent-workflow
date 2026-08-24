import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialSummary,
  PutOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import type { OwnRepositoryCredentialSubject } from './types'

export interface OwnRepositoryTransportCredentialCommands {
  put(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): OwnCodeHostPushCredentialSummary
  remove(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): { readonly removed: boolean }
}
