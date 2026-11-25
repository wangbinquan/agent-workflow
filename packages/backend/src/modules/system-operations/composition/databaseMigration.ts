// RFC-349 — bootstrap-only composition for the database migration application.

import {
  createFileSnapshotTracker,
  type FileSnapshotTracker,
} from '@/platform/persistence/fileSnapshots'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { SchemaHistoryRuntime } from '@/platform/persistence/schema/history/runtime'
import { Paths } from '@/platform/configuration/installationPaths'
import type { DatabaseConfigurationPort } from '../application/ports/databaseConfiguration'
import { createFileDatabaseConfiguration } from '../infrastructure/local/fileDatabaseConfiguration'

/** RFC-524: the local config file's database configuration, for the roots that select it. */
export { createFileDatabaseConfiguration }
import { createDatabaseMigrationApplication } from '../application/databaseMigrationApplication'
import type { DatabaseMigrationAdmissionPort } from '../application/databaseMigrationRunner'
import { createDatabaseMigrationCoordinator } from '../infrastructure/databaseMigrationCoordinator'
import type { LocalSystemOperationContext } from '../public/types'
import { createDatabaseMigrationOperationDescriptors } from '../application/operationDescriptors'

export interface DatabaseMigrationModule {
  readonly application: ReturnType<typeof createDatabaseMigrationApplication>
  readonly operations: ReturnType<typeof createDatabaseMigrationOperationDescriptors>
  readonly coordinator: ReturnType<typeof createDatabaseMigrationCoordinator>
}

export function composeDatabaseMigrationModule(input: {
  readonly contract: LogicalSchemaContract
  /** RFC-549: the binary's schema history, from bootstrap. */
  readonly schemaHistory: SchemaHistoryRuntime
  readonly admission: DatabaseMigrationAdmissionPort
  readonly sqlitePath?: string
  readonly operationsRoot?: string
  readonly generationPointerPath?: string
  readonly executionMode?: 'inline' | 'background'
  readonly onBackgroundFailure?: (input: {
    readonly operationId: string
    readonly error: unknown
  }) => void
  /** RFC-524: the caller selects it (daemon and CLI: the local config file). */
  readonly configuration: DatabaseConfigurationPort
  /** RFC-539: the tracker the safety backup counts its snapshots on (the daemon: its own database's; the CLI: its own). */
  readonly fileSnapshots: FileSnapshotTracker
}): DatabaseMigrationModule {
  const configuration = input.configuration
  const coordinator = createDatabaseMigrationCoordinator({
    headContract: input.contract,
    contract: input.contract,
    schemaHistory: input.schemaHistory,
    sqlitePath: input.sqlitePath ?? Paths.db,
    operationsRoot: input.operationsRoot ?? Paths.databaseMigrationsDir,
    generationPointerPath: input.generationPointerPath ?? Paths.databaseGenerationPointer,
    admission: input.admission,
    executionMode: input.executionMode,
    onBackgroundFailure: input.onBackgroundFailure,
    activateTargetConfig: (target) => configuration.write(target),
    activateSourceConfig: () => configuration.write({ provider: 'sqlite' }),
    fileSnapshots: input.fileSnapshots,
  })
  const application = createDatabaseMigrationApplication(coordinator)
  return Object.freeze({
    application,
    operations: createDatabaseMigrationOperationDescriptors(application),
    coordinator,
  })
}

export interface LocalDatabaseMigrationOperations {
  readonly context: LocalSystemOperationContext
  readonly application: DatabaseMigrationModule['application']
  readonly coordinator: DatabaseMigrationModule['coordinator']
}

/**
 * CLI composition. Mutating CLI adapters must hold the daemon lock for their
 * entire command before calling this application; that lock is the offline
 * implementation of freeze/drain/reopen admission.
 */
export function composeLocalDatabaseMigrationOperations(
  contract: LogicalSchemaContract,
  schemaHistory: SchemaHistoryRuntime,
): LocalDatabaseMigrationOperations {
  const module = composeDatabaseMigrationModule({
    contract,
    schemaHistory,
    configuration: createFileDatabaseConfiguration(Paths.config),
    // RFC-539: the CLI holds the daemon lock — no daemon checkpoint runs while it snapshots.
    fileSnapshots: createFileSnapshotTracker(),
    admission: {
      async freezeAndDrain() {},
      async reopenSqlite() {},
      async activatePostgresql() {},
      async openPostgresqlAdmission() {},
    },
  })
  return Object.freeze({
    context: Object.freeze({}) as LocalSystemOperationContext,
    application: module.application,
    coordinator: module.coordinator,
  })
}
