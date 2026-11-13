import type { OwnCodeHostPushCredentialList } from '@agent-workflow/shared'
import type { OwnRepositoryCredentialSubject } from './types'

export type { WorkspacePresenceQueries } from '../application/ports/workspacePresence'
export type { RepositoryWorkspaceReadQueries } from '../application/ports/repositoryWorkspaceReadQueries'
export { selectRepositoryWorkspaceReadQueries } from '../composition/repositoryWorkspaceReadQueries'
// RFC-478：`resolveRepoGroupLayout` 模块外唯一的读者是 `services/task.ts`（延后准备的重试回收），那段迁进 task-execution 后改经
// task 自有的准备绑定（source-control 在 `composition/repositoryPreparation.ts` 实现 `groupCachedRepoIds`），这一出口撤出。

export interface OwnRepositoryTransportCredentialQueries {
  list(subject: OwnRepositoryCredentialSubject): Promise<OwnCodeHostPushCredentialList>
}

/** Secret-free system projection; no repository persistence mechanism leaks. */
export interface RepositoryOverviewQueries {
  countCachedRepositories(): Promise<number>
}

export { repoRelForcedPaths } from '@/platform/workspace/forcedWorkspacePaths'
// RFC-491: the task agent mount rule (RFC-487) is no longer offered here — its one production reader, the native
// compatibility run, left production for tests/helpers; source-control's own workspace contents read the domain rule.

export {
  existingRepositoryIds,
  repositoryExistsExpression,
} from '../infrastructure/repositoryIdentityQueries'
