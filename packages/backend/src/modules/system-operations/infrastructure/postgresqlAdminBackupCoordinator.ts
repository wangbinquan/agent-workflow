// RFC-349 — System Operations adapter for a live PostgreSQL generation.
// Transport/application code keeps the existing AdminBackupCoordinatorPort;
// this infrastructure edge selects the provider-specific logical backup.

import type { AdminBackupCoordinatorPort } from '../application/ports/adminBackupCoordinator'
import {
  createPostgresqlProviderBackup,
  type CreatePostgresqlProviderBackupOptions,
} from './postgresqlProviderBackup'

type CreatePostgresqlBackup = (
  options: CreatePostgresqlProviderBackupOptions,
) => ReturnType<typeof createPostgresqlProviderBackup>

export function createPostgresqlAdminBackupCoordinator(input: {
  readonly runtime: CreatePostgresqlProviderBackupOptions['runtime']
  readonly appHome: string
  /** Application-owned preparation such as portable asset consistency checks. */
  readonly prepare?: () => Promise<void> | void
  /** Infrastructure test seam; production uses the provider backup implementation. */
  readonly createBackup?: CreatePostgresqlBackup
}): AdminBackupCoordinatorPort {
  const createBackup = input.createBackup ?? createPostgresqlProviderBackup
  return Object.freeze({
    async request(request: Parameters<AdminBackupCoordinatorPort['request']>[0]) {
      await input.prepare?.()
      return await createBackup({
        runtime: input.runtime,
        appHome: input.appHome,
        includeWorktrees: request.includeWorktrees,
      })
    },
  })
}
