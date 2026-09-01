// RFC-349 — PostgreSQL System Operations restore coordinator.
//
// Recovery is deliberately out-of-place: the configured profile must point at
// an empty application/meta schema or at the same resumable logical operation.
// A live non-empty schema is never dropped or overwritten.

import { existsSync } from 'node:fs'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  preflightPostgresqlTarget,
  PostgresqlPreflightError,
} from '@/platform/persistence/postgresqlPreflight'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { DomainError } from '@/util/errors'
import { acquireLock, isProcessAlive, readPidFromLock } from '@/util/lock'
import type { AdminRestoreCoordinatorPort } from '../application/ports/adminRestoreCoordinator'
import type { RestoreArtifactPathResolver } from './restoreArtifactIngress'
import {
  inspectPortableDatabaseBackup,
  type PortableDatabaseBackupInspection,
  type PortableRestoreFilesystemAssets,
} from './portableDatabaseRestore'
import {
  clearPendingPostgresqlRestore,
  completePendingPostgresqlRestore,
  listFailedPostgresqlRestores,
  projectPendingPostgresqlRestore,
  quarantinePendingPostgresqlRestore,
  readPendingPostgresqlRestore,
  stagePendingPostgresqlRestore,
} from './postgresqlPendingRestore'
import { restorePostgresqlProviderBackup } from './postgresqlProviderRestore'

const TARGET_GUIDANCE =
  'PostgreSQL restore requires the configured database profile to point at an empty target or the same resumable restore operation; stop writes, switch the profile to an empty target, and retry'

type InspectBackup = typeof inspectPortableDatabaseBackup
type PreflightTarget = typeof preflightPostgresqlTarget
type RestoreBackup = typeof restorePostgresqlProviderBackup

export interface PostgresqlAdminRestoreCoordinator extends AdminRestoreCoordinatorPort {
  /** Boot-only recovery hook. Must run after the daemon lock and before any
   * business client/worker is opened. */
  applyPending(): Promise<boolean>
}

export interface CreatePostgresqlAdminRestoreCoordinatorInput {
  readonly artifacts: RestoreArtifactPathResolver
  readonly runtime: PostgresqlDatabaseRuntime
  readonly targetGenerationId: string
  readonly appHome: string
  readonly lockPath: string
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
  readonly filesystem: PortableRestoreFilesystemAssets
  readonly now?: () => number
  readonly inspectBackup?: InspectBackup
  readonly preflightTarget?: PreflightTarget
  readonly restoreBackup?: RestoreBackup
  readonly readPid?: typeof readPidFromLock
  readonly processAlive?: typeof isProcessAlive
  readonly lock?: typeof acquireLock
}

function restoreOperationId(inspection: PortableDatabaseBackupInspection): string {
  return `dbm_restore_${inspection.envelope.digest.slice('sha256:'.length, 'sha256:'.length + 32)}`
}

function targetRefusal(error: unknown): never {
  if (error instanceof PostgresqlPreflightError && error.code === 'postgresql-target-not-empty') {
    throw new DomainError('postgresql-restore-target-not-empty', TARGET_GUIDANCE, 409, undefined)
  }
  throw error
}

export function createPostgresqlAdminRestoreCoordinator(
  input: CreatePostgresqlAdminRestoreCoordinatorInput,
): PostgresqlAdminRestoreCoordinator {
  const now = input.now ?? Date.now
  const inspect = input.inspectBackup ?? inspectPortableDatabaseBackup
  const preflight = input.preflightTarget ?? preflightPostgresqlTarget
  const restore = input.restoreBackup ?? restorePostgresqlProviderBackup

  const inspectArtifact = async (tarballPath: string) => {
    const provisionalOperationId = `dbm_restore_inspect_${crypto.randomUUID().replaceAll('-', '')}`
    return await inspect({
      tarballPath,
      appHome: input.appHome,
      restoreOperationId: provisionalOperationId,
      contract: input.contract,
    })
  }

  const assertTarget = async (operationId: string): Promise<void> => {
    try {
      await preflight({ runtime: input.runtime, operationId })
    } catch (error) {
      targetRefusal(error)
    }
  }

  const restoreArtifact = async (tarballPath: string, operationId: string) =>
    await restore({
      tarballPath,
      appHome: input.appHome,
      restoreOperationId: operationId,
      runtime: input.runtime,
      targetGenerationId: input.targetGenerationId,
      contract: input.contract,
      plan: input.plan,
      filesystem: input.filesystem,
      now,
    })

  const coordinator: PostgresqlAdminRestoreCoordinator = {
    async plan(artifactRef) {
      const inspection = await inspectArtifact(input.artifacts.pathOf(artifactRef))
      await assertTarget(restoreOperationId(inspection))
      const migrationAt = inspection.manifest.migration.lastCreatedAt
      return {
        backupKind: inspection.manifest.kind,
        backupMigrationCreatedAt: migrationAt,
        binaryMigrationCreatedAt: migrationAt ?? 0,
        direction: 'same',
      }
    },

    async stage(artifactRef, options) {
      const tarballPath = input.artifacts.pathOf(artifactRef)
      const inspection = await inspectArtifact(tarballPath)
      const operationId = restoreOperationId(inspection)
      await assertTarget(operationId)
      stagePendingPostgresqlRestore({
        appHome: input.appHome,
        tarballPath,
        operationId,
        generationId: input.targetGenerationId,
        noSafetyBackup: options.noSafetyBackup,
        noMigrate: options.noMigrate,
        skipIntegrityCheck: options.skipIntegrityCheck,
        requestedAt: now(),
      })
      return { direction: 'same' }
    },

    status() {
      return {
        pending: projectPendingPostgresqlRestore(input.appHome),
        failed: listFailedPostgresqlRestores(input.appHome),
      }
    },

    cancel() {
      return { cleared: clearPendingPostgresqlRestore(input.appHome) }
    },

    async activateLocal(artifactRef) {
      const readPid = input.readPid ?? readPidFromLock
      const processAlive = input.processAlive ?? isProcessAlive
      const pid = readPid(input.lockPath)
      if (pid !== null && processAlive(pid)) return { status: 'daemon-running', pid }

      let lock: ReturnType<typeof acquireLock>
      try {
        lock = (input.lock ?? acquireLock)(input.lockPath)
      } catch {
        return { status: 'lock-unavailable' }
      }
      try {
        const tarballPath = input.artifacts.pathOf(artifactRef)
        const inspection = await inspectArtifact(tarballPath)
        const operationId = restoreOperationId(inspection)
        await assertTarget(operationId)
        const restored = await restoreArtifact(tarballPath, operationId)
        return {
          status: 'completed',
          direction: 'same',
          safetyBackupPath: null,
          migrated: false,
          restored: {
            db: true,
            config: restored.filesystem.config,
            skills: restored.filesystem.skills,
          },
        }
      } finally {
        lock.release()
      }
    },

    async applyPending() {
      const pending = readPendingPostgresqlRestore(input.appHome)
      if (pending === null) return false
      if (!existsSync(pending.stagedTarball)) {
        clearPendingPostgresqlRestore(input.appHome)
        return false
      }
      if (pending.generationId !== input.targetGenerationId) {
        throw new DomainError(
          'postgresql-restore-generation-mismatch',
          'staged PostgreSQL restore belongs to another verified generation',
          409,
          undefined,
        )
      }
      try {
        const inspection = await inspectArtifact(pending.stagedTarball)
        if (restoreOperationId(inspection) !== pending.operationId) {
          throw new DomainError(
            'postgresql-restore-operation-mismatch',
            'staged PostgreSQL restore artifact differs from its admitted operation',
            409,
            undefined,
          )
        }
        await assertTarget(pending.operationId)
        await restoreArtifact(pending.stagedTarball, pending.operationId)
        completePendingPostgresqlRestore(input.appHome)
        return true
      } catch (error) {
        quarantinePendingPostgresqlRestore(input.appHome, error, now())
        throw error
      }
    },
  }
  return Object.freeze(coordinator)
}
