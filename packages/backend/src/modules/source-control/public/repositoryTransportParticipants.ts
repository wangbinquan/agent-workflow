import type { CodeHostProvider } from '@agent-workflow/shared'
import type { RepositoryTransportCredentialSelection } from './types'

export interface RepositoryTransportCredentialSelectionParticipant {
  select(input: {
    readonly subject:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'system' }
    readonly provider: CodeHostProvider
  }): RepositoryTransportCredentialSelection
}
