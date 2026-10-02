// RFC-370 A-T2: standalone installation effects. Paths, the daemon lock,
// durable file metadata and local copy recovery stay behind this adapter.
import type { DaemonStartupLease } from '../../application/ports/daemonStartupLease'
import type { DatabaseConfigurationPort } from '../../application/ports/databaseConfiguration'
import type { DatabaseInstallationPort } from '../../application/ports/databaseInstallation'
import type { OpenDbOptions } from '@/db/client'
import {
  prepareDatabaseProviderRuntime,
  type ResolveDatabaseProviderRuntimeOptions,
} from '@/platform/persistence/databaseProviderRuntime'
import { writeDatabaseGenerationAtomic } from '@/platform/persistence/generationStore'
import {
  resolvePostgresqlAdditiveRowBridge,
  type PostgresqlMigrationHistory,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { acquireLock, type Lock } from '@/util/lock'
import { createDatabaseMigrationControlPlane } from '../../application/databaseMigrationControlPlane'
import {
  createDatabaseMigrationCoordinator,
  readDatabaseSchemaUpgradeGeneration,
} from '../databaseMigrationCoordinator'
import { createFileDatabaseMigrationStore } from '../fileDatabaseMigrationStore'

export interface DatabaseSchemaUpgradeOptions extends ResolveDatabaseProviderRuntimeOptions {
  readonly sqliteOptions: Omit<OpenDbOptions, 'path'>
  readonly beforeSqliteOpen?: () => void | Promise<void>
  readonly lockPath: string
  /** Daemon start already owns this lock before pending restore. */
  readonly lock?: Pick<DaemonStartupLease, 'release'>
  readonly readConfig: DatabaseConfigurationPort['read']
  readonly writeConfig: DatabaseConfigurationPort['write']
  readonly history?: PostgresqlMigrationHistory
  /** File-commit fault seams; production keeps the durable writer defaults. */
  readonly beforePointerReplaceForTest?: () => void
  readonly afterPointerReplaceForTest?: () => void
}

export function createFileDatabaseInstallation(
  options: DatabaseSchemaUpgradeOptions & { readonly history: PostgresqlMigrationHistory },
): DatabaseInstallationPort<Awaited<ReturnType<typeof prepareDatabaseProviderRuntime>>> {
  const controlPlane = createDatabaseMigrationControlPlane({
    store: createFileDatabaseMigrationStore({ root: options.operationsRoot }),
  })
  let heldLock: Lock | undefined
  return {
    readGeneration: (input) => readDatabaseSchemaUpgradeGeneration({ ...options, ...input }),
    resolveRecoverySource: (input) =>
      resolvePostgresqlAdditiveRowBridge(options.history, input).source,
    listMigrations: () => controlPlane.list(),
    readMigration: (operationId) => controlPlane.readManifest(operationId),
    writeGeneration: (payload) =>
      writeDatabaseGenerationAtomic({
        pointerPath: options.generationPointerPath,
        payload,
        beforeReplaceForTest: options.beforePointerReplaceForTest,
        afterReplaceForTest: options.afterPointerReplaceForTest,
      }),
    requireUpgradeLock() {
      if (options.lock === undefined && heldLock === undefined)
        heldLock = acquireLock(options.lockPath)
    },
    releaseUpgradeLock() {
      heldLock?.release()
      heldLock = undefined
    },
    async resumeMigration(input) {
      const recovery = createDatabaseMigrationCoordinator({
        sqlitePath: options.sqlitePath,
        operationsRoot: options.operationsRoot,
        generationPointerPath: options.generationPointerPath,
        contract: input.contract,
        interruptedOperationId: input.operationId,
        env: options.env,
        // The held daemon lock is the standalone freeze/drain boundary.
        admission: {
          async freezeAndDrain() {},
          async reopenSqlite() {},
          async activatePostgresql() {},
          async openPostgresqlAdmission() {},
        },
        activateTargetConfig: (target) => options.writeConfig(target),
        activateSourceConfig: () => options.writeConfig({ provider: 'sqlite' }),
      })
      return await recovery.resumeInterrupted(input.target)
    },
    prepareProvider: (input) => prepareDatabaseProviderRuntime({ ...options, ...input }),
  }
}
