import type { TaskRepositoryPreparationBinding } from '../infrastructure/repositoryPreparationBinding'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { SecretBox } from '@/auth/secretBox'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/ports/repositoryWorkspaceStore'
import {
  composeDeferredRepositoryPreparationStep,
  type WorkspaceCleanupHookEvent,
} from '@/services/task'
import { loadFrozenSpaceLayout } from '../infrastructure/frozenWorkspaceLayout'
import type { PersistedRepositoryPreparationStep } from '../application/drive/repositoryPreparationStep'

/**
 * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— 组合根取**延后仓库准备**步骤的唯一入口。
 *
 * 交给 `TaskDriveCoordinator` 当 `repositoryPreparation`。此前 PostgreSQL 的几个根一律传
 * `skipRepositoryPreparation`，于是 G7 在那一侧等于没实现：远端拉不动时同步抛错、
 * 一行任务都不留（`rfc359-w5hn-deferred-repo-preparation-parity` 钉过那处落差）。
 *
 * `repositoryWorkspace` 必填、`loadFrozenSpaceLayout` 用中立那份：这一步因此不认识任何引擎。
 */
export function composeDeferredRepositoryPreparation(input: {
  readonly repositoryPreparation: TaskRepositoryPreparationBinding
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly repositoryWorkspace: RepositoryWorkspaceStore
  readonly secretBox?: SecretBox
  readonly cloneTimeoutMs?: number
  readonly gitBaselineSyncWindowMs?: number
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}): PersistedRepositoryPreparationStep {
  return composeDeferredRepositoryPreparationStep({
    deps: {
      db: input.db,
      repositoryPreparation: input.repositoryPreparation,
      repositoryWorkspace: input.repositoryWorkspace,
      loadFrozenSpaceLayout: (sourceTaskId) => loadFrozenSpaceLayout(input.db, sourceTaskId),
      ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
      ...(input.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: input.cloneTimeoutMs }),
      ...(input.gitBaselineSyncWindowMs === undefined
        ? {}
        : { gitBaselineSyncWindowMs: input.gitBaselineSyncWindowMs }),
      ...(input.workspaceCleanupHook === undefined
        ? {}
        : { workspaceCleanupHook: input.workspaceCleanupHook }),
    },
    appHome: input.appHome,
  })
}
