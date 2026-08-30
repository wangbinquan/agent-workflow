// RFC-346 — compatibility adapter around the existing RFC-213 backup/restore
// mechanisms. The adapter is the only System Operations path that imports the
// legacy services; RFC-294 W9-E replaces its physical restore internals.

import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { createBackup } from '@/services/backup'
import {
  clearPendingRestore,
  listFailedRestores,
  readPendingRestore,
  stagePendingRestore,
} from '@/services/pendingRestore'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import { planRestore, restoreBackup, validateBackupForStage } from '@/services/restore'
import { acquireLock, isProcessAlive, readPidFromLock } from '@/util/lock'
import type { AdminBackupCoordinatorPort } from '../application/ports/adminBackupCoordinator'
import type { AdminRestoreCoordinatorPort } from '../application/ports/adminRestoreCoordinator'
import type { RestoreArtifactPathResolver } from './restoreArtifactIngress'

interface BackupResources {
  readonly db: DbClient
  readonly secretBox: SecretBox | undefined
}

export interface LegacySystemOperationMechanisms {
  readonly ensureCredentialsSealed: typeof ensureCredentialsSealed
  readonly createBackup: typeof createBackup
  readonly planRestore: typeof planRestore
  readonly validateBackupForStage: typeof validateBackupForStage
  readonly stagePendingRestore: typeof stagePendingRestore
  readonly readPendingRestore: typeof readPendingRestore
  readonly listFailedRestores: typeof listFailedRestores
  readonly clearPendingRestore: typeof clearPendingRestore
  readonly readPidFromLock: typeof readPidFromLock
  readonly isProcessAlive: typeof isProcessAlive
  readonly acquireLock: typeof acquireLock
  readonly restoreBackup: typeof restoreBackup
}

const DEFAULT_MECHANISMS: LegacySystemOperationMechanisms = {
  ensureCredentialsSealed,
  createBackup,
  planRestore,
  validateBackupForStage,
  stagePendingRestore,
  readPendingRestore,
  listFailedRestores,
  clearPendingRestore,
  readPidFromLock,
  isProcessAlive,
  acquireLock,
  restoreBackup,
}

export interface LegacyPlatformRecoveryAdapter {
  readonly backup: AdminBackupCoordinatorPort
  readonly restore: AdminRestoreCoordinatorPort
}

export function createLegacyPlatformRecoveryAdapter(deps: {
  readonly artifacts: RestoreArtifactPathResolver
  readonly backupResources: () => Promise<BackupResources> | BackupResources
  readonly appHome: string
  readonly dbPath: string
  readonly lockPath: string
  readonly resolveRestoreMigrations: () => Promise<string>
  readonly now?: () => number
  readonly mechanisms?: Partial<LegacySystemOperationMechanisms>
}): LegacyPlatformRecoveryAdapter {
  const mechanisms: LegacySystemOperationMechanisms = {
    ...DEFAULT_MECHANISMS,
    ...deps.mechanisms,
  }
  const now = deps.now ?? Date.now

  const backup: AdminBackupCoordinatorPort = {
    async request(input) {
      const resources = await deps.backupResources()
      mechanisms.ensureCredentialsSealed(resources.db, resources.secretBox, {
        blockOnCredentialedPath: true,
      })
      return mechanisms.createBackup({
        db: resources.db,
        includeWorktrees: input.includeWorktrees,
        appHome: deps.appHome,
      })
    },
  }

  const restore: AdminRestoreCoordinatorPort = {
    async plan(artifactRef) {
      const plan = await mechanisms.planRestore(deps.artifacts.pathOf(artifactRef), {
        appHome: deps.appHome,
        migrationsFolder: await deps.resolveRestoreMigrations(),
      })
      return {
        backupKind: plan.manifest?.kind ?? null,
        backupMigrationCreatedAt: plan.backupLastCreatedAt,
        binaryMigrationCreatedAt: plan.currentMaxWhen,
        direction: plan.direction,
      }
    },
    async stage(artifactRef, input) {
      const path = deps.artifacts.pathOf(artifactRef)
      const migrationsFolder = await deps.resolveRestoreMigrations()
      const plan = await mechanisms.validateBackupForStage(path, {
        appHome: deps.appHome,
        migrationsFolder,
        skipIntegrityCheck: input.skipIntegrityCheck,
      })
      mechanisms.stagePendingRestore(path, {
        appHome: deps.appHome,
        noSafetyBackup: input.noSafetyBackup,
        noMigrate: input.noMigrate,
        skipIntegrityCheck: input.skipIntegrityCheck,
        now: now(),
      })
      return { direction: plan.direction }
    },
    status() {
      return {
        pending: mechanisms.readPendingRestore(deps.appHome),
        failed: mechanisms.listFailedRestores(deps.appHome),
      }
    },
    cancel() {
      return { cleared: mechanisms.clearPendingRestore(deps.appHome) }
    },
    async activateLocal(artifactRef, input) {
      const pid = mechanisms.readPidFromLock(deps.lockPath)
      if (pid !== null && mechanisms.isProcessAlive(pid)) {
        return { status: 'daemon-running', pid }
      }

      let lock: ReturnType<typeof acquireLock>
      try {
        lock = mechanisms.acquireLock(deps.lockPath)
      } catch {
        return { status: 'lock-unavailable' }
      }

      try {
        const result = await mechanisms.restoreBackup(deps.artifacts.pathOf(artifactRef), {
          appHome: deps.appHome,
          dbPath: deps.dbPath,
          migrationsFolder: await deps.resolveRestoreMigrations(),
          noSafetyBackup: input.noSafetyBackup,
          noMigrate: input.noMigrate,
          skipIntegrityCheck: input.skipIntegrityCheck,
        })
        return { status: 'completed', ...result }
      } finally {
        lock.release()
      }
    },
  }

  return Object.freeze({ backup: Object.freeze(backup), restore: Object.freeze(restore) })
}
