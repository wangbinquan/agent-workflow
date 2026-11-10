import type { RepositoryPreparationLookup } from '../application/ports/repositoryPreparationLookup'
import type { TaskRepositoryPreparationBinding } from '../infrastructure/repositoryPreparationBinding'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SecretBox } from '@/auth/secretBox'
import { type WorkspaceCleanupHookEvent } from '../application/ports/preparedWorkspace'

import { loadFrozenSpaceLayout } from '../infrastructure/frozenWorkspaceLayout'
import { PersistedRepositoryPreparationStep } from '../application/drive/repositoryPreparationStep'
import type { TaskLaunchConfigurationQueries } from '../application/ports/taskLaunchConfiguration'
import {
  createDeferredRepositoryPreparationMechanics,
  createDeferredRepositoryPreparationReader,
  type DeferredRepositoryPreparationDependencies,
} from '../infrastructure/deferredRepositoryPreparation'

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①）—— 两个 provider 共用的**延后仓库准备**步骤。
 *
 * 交给 `TaskDriveCoordinator` 当 `repositoryPreparation`：任务行先落 `pending`，
 * 克隆 / 抓取 / 多仓物化 / 建工作树由驱动认领后作为第 0 步推进，失败转 `failed`
 * 且 git 原文可见（RFC-287 G7）。
 *
 * RFC-478：原在 `services/task.ts`；描述读取与执行两个端口的实现在 `infrastructure/deferredRepositoryPreparation.ts`，
 * 这里只装配。
 */
export function composeDeferredRepositoryPreparationStep(input: {
  readonly deps: DeferredRepositoryPreparationDependencies
  readonly appHome: string
}): PersistedRepositoryPreparationStep {
  return new PersistedRepositoryPreparationStep(
    createDeferredRepositoryPreparationReader({ deps: input.deps }),
    createDeferredRepositoryPreparationMechanics(input),
  )
}

/**
 * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— 组合根取**延后仓库准备**步骤的唯一入口。
 *
 * 交给 `TaskDriveCoordinator` 当 `repositoryPreparation`。此前 PostgreSQL 的几个根一律传
 * `skipRepositoryPreparation`，于是 G7 在那一侧等于没实现：远端拉不动时同步抛错、
 * 一行任务都不留（`rfc359-w5hn-deferred-repo-preparation-parity` 钉过那处落差）。
 *
 * `repositoryPreparation` 必填、`loadFrozenSpaceLayout` 由 Task 提供：这一步因此不认识任何引擎。
 */
export function composeDeferredRepositoryPreparation(input: {
  readonly repositoryPreparationLookup: RepositoryPreparationLookup
  readonly repositoryPreparation: TaskRepositoryPreparationBinding
  readonly db: PersistenceDb
  readonly appHome: string
  readonly secretBox?: SecretBox
  readonly cloneTimeoutMs?: number
  readonly gitBaselineSyncWindowMs?: number
  readonly launchConfiguration?: TaskLaunchConfigurationQueries
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}): PersistedRepositoryPreparationStep {
  return composeDeferredRepositoryPreparationStep({
    deps: {
      db: input.db,
      repositoryPreparation: input.repositoryPreparation,
      repositoryPreparationLookup: input.repositoryPreparationLookup,
      loadFrozenSpaceLayout: (sourceTaskId) => loadFrozenSpaceLayout(input.db, sourceTaskId),
      ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
      ...(input.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: input.cloneTimeoutMs }),
      ...(input.gitBaselineSyncWindowMs === undefined
        ? {}
        : { gitBaselineSyncWindowMs: input.gitBaselineSyncWindowMs }),
      ...(input.launchConfiguration === undefined
        ? {}
        : { launchConfiguration: input.launchConfiguration }),
      ...(input.workspaceCleanupHook === undefined
        ? {}
        : { workspaceCleanupHook: input.workspaceCleanupHook }),
    },
    appHome: input.appHome,
  })
}
