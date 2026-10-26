import { existsSync } from 'node:fs'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { DatabaseMigrationRunnerError } from '../../application/databaseMigrationRunner'
import { createDatabaseMigrationControlPlane } from '../../application/databaseMigrationControlPlane'
import { createFileDatabaseMigrationStore } from '../fileDatabaseMigrationStore'
import { createDatabaseMigrationCoordinator } from '../databaseMigrationCoordinator'
import type { DatabaseSchemaUpgradeOptions } from './fileDatabaseInstallation'
import type { DatabaseMigrationCoordinatorPort } from '../../application/ports/databaseMigrationCoordinator'

/** Read-only discovery does not require the daemon lock; a selected recovery does. */
export async function recoverEpoch2ProviderMove(
  options: Omit<DatabaseSchemaUpgradeOptions, 'readConfig' | 'writeConfig'> & {
    readonly requireUpgradeLock?: () => void | Promise<void>
  },
  /** The recovery selection can be tested without running a complete provider copy. */
  resumeMigration?: DatabaseMigrationCoordinatorPort['resumeInterrupted'],
): Promise<void> {
  if (!existsSync(options.generationPointerPath)) return
  const pointer = readGenerationPointerV2(options.generationPointerPath)
  const control = createDatabaseMigrationControlPlane({
    store: createFileDatabaseMigrationStore({ root: options.operationsRoot }),
  })
  const candidates = control
    .list()
    .filter(
      (status) =>
        status.rolledBackAt === null &&
        status.phase !== 'finalized' &&
        ((status.operationId === pointer.payload.operationId &&
          pointer.payload.generationId === `dbg_pg_${status.operationId.slice(4)}`) ||
          (status.sourceGenerationId === pointer.payload.generationId &&
            status.phase === 'switched')),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  let pending: (typeof candidates)[number] | undefined
  for (const candidate of candidates) {
    if (pointer.payload.operationId === candidate.operationId) {
      pending = candidate
      break
    }
    // AF-D6: a crash after activation but before publishing the pointer is the
    // only source-bound operation boot may finish. Earlier copies stay parked.
    const runtime = createPostgresqlDatabaseRuntime({
      config: candidate.target,
      generationId: `dbg_pg_${candidate.operationId.slice(4)}`,
      env: options.env,
      poolFactory: options.postgresqlPoolFactory,
    })
    try {
      const rows = await runtime
        .providerPool()
        .unsafe(
          'SELECT state FROM agent_workflow_meta.generations WHERE generation_id=$1 AND operation_id=$2',
          [runtime.generationId, candidate.operationId],
        )
      if (rows[0]?.state === 'active') pending = candidate
    } finally {
      await runtime.close()
    }
    if (pending) break
  }
  if (!pending) return
  const manifest = control.readManifest(pending.operationId)
  if (
    manifest.payload.failure !== null ||
    manifest.payload.cancelledAt !== null ||
    manifest.payload.cancellationRequestedAt !== null
  )
    throw new DatabaseMigrationRunnerError(
      'database-migration-resume-required',
      `database migration ${pending.operationId} is failed or cancelled; explicitly resume it before starting on its target`,
    )
  if (pending.phase === 'accepting-writes') return
  await options.requireUpgradeLock?.()
  const recovery = createDatabaseMigrationCoordinator({
    ...options,
    headContract: options.contract,
    interruptedOperationId: pending.operationId,
    admission: {
      async freezeAndDrain() {},
      async reopenSqlite() {},
      async activatePostgresql() {},
      async openPostgresqlAdmission() {},
    },
    // Epoch-2 configuration remains authoritative through the pointer's profileRef.
    async activateTargetConfig() {},
    async activateSourceConfig() {},
  })
  const result = await (resumeMigration ?? recovery.resumeInterrupted)(pending.target)
  if (result?.phase !== 'accepting-writes' || result.failure)
    throw new Error('database-migration-resume-required')
}
