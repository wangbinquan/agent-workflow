// RFC-349 — System Operations adapter for a live PostgreSQL generation.
// Transport/application code keeps the existing AdminBackupCoordinatorPort;
// this infrastructure edge selects the provider-specific logical backup.
//
// RFC-359 W9：备份的「应用侧资产」（workflow YAML、live worktree）没有 provider 差异，
// 由中立的 `createPortableBackupApplicationAssets` 提供；本文件只保留真正按引擎分叉的那
// 一半——逻辑快照的取法与 cutover 归档的携带。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { AdminBackupCoordinatorPort } from '../application/ports/adminBackupCoordinator'
import { createPortableBackupApplicationAssets } from '@/platform/persistence/portableApplicationAssets'
import {
  createPostgresqlProviderBackup,
  type CreatePostgresqlProviderBackupOptions,
} from './postgresqlProviderBackup'

type CreatePostgresqlBackup = (
  options: CreatePostgresqlProviderBackupOptions,
) => ReturnType<typeof createPostgresqlProviderBackup>

export function createPostgresqlAdminBackupCoordinator(input: {
  readonly runtime: CreatePostgresqlProviderBackupOptions['runtime']
  /** Provider-neutral client for the application-owned rows the archive carries. */
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  /** Application-owned preparation such as portable asset consistency checks. */
  readonly prepare?: () => Promise<void> | void
  /** Infrastructure test seam; production uses the provider backup implementation. */
  readonly createBackup?: CreatePostgresqlBackup
}): AdminBackupCoordinatorPort {
  const createBackup = input.createBackup ?? createPostgresqlProviderBackup
  const application = createPortableBackupApplicationAssets({ db: input.db })
  return Object.freeze({
    async request(request: Parameters<AdminBackupCoordinatorPort['request']>[0]) {
      await input.prepare?.()
      return await createBackup({
        runtime: input.runtime,
        appHome: input.appHome,
        application,
        includeWorktrees: request.includeWorktrees,
      })
    },
  })
}
