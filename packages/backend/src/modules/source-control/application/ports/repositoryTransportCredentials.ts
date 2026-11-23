// RFC-551 (RFC-294 S9): the own-credential command and query ports and the credential selection participant this module's transport credentials implement. They sat on `public/` without any other module consuming them.
import type { OwnRepositoryCredentialSubject } from '../../public/types'
import type {
  CodeHostProvider,
  OwnCodeHostPushCredentialList,
  OwnCodeHostPushCredentialSummary,
  PutOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import type { RepositoryTransportCredentialSelection } from '../../domain/repositoryTransportCredential'

export interface OwnRepositoryTransportCredentialCommands {
  put(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): Promise<OwnCodeHostPushCredentialSummary>
  remove(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): Promise<{ readonly removed: boolean }>
}

// RFC-478：`resolveRepoGroupLayout` 模块外唯一的读者是 `services/task.ts`（延后准备的重试回收），那段迁进 task-execution 后改经
// task 自有的准备绑定（source-control 在 `infrastructure/repositoryPreparationBridge.ts` 实现 `groupCachedRepoIds`），这一出口撤出。

export interface OwnRepositoryTransportCredentialQueries {
  list(subject: OwnRepositoryCredentialSubject): Promise<OwnCodeHostPushCredentialList>
}

export interface RepositoryTransportCredentialSelectionParticipant {
  select(input: {
    readonly subject:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'system' }
    readonly provider: CodeHostProvider
  }): Promise<RepositoryTransportCredentialSelection>
}
