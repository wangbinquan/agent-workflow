// RFC-349 — bootstrap-only composition for the database migration application.

import { Paths } from '@/util/paths'
import type { DatabaseConfigurationPort } from '../application/ports/databaseConfiguration'
import { createFileDatabaseConfiguration } from '../infrastructure/local/fileDatabaseConfiguration'
import { createDatabaseMigrationApplication } from '../application/databaseMigrationApplication'
import type { DatabaseMigrationAdmissionPort } from '../application/databaseMigrationRunner'
import { createDatabaseMigrationCoordinator } from '../infrastructure/databaseMigrationCoordinator'
import { createDatabaseMigrationOperationDescriptors } from '../public/operations'
import type { LocalSystemOperationContext } from '../public/types'

export interface DatabaseMigrationModule {
  readonly application: ReturnType<typeof createDatabaseMigrationApplication>
  readonly operations: ReturnType<typeof createDatabaseMigrationOperationDescriptors>
  readonly coordinator: ReturnType<typeof createDatabaseMigrationCoordinator>
}

export function composeDatabaseMigrationModule(
  input: {
    readonly admission: DatabaseMigrationAdmissionPort
    readonly sqlitePath?: string
    readonly operationsRoot?: string
    readonly generationPointerPath?: string
    readonly executionMode?: 'inline' | 'background'
    readonly onBackgroundFailure?: (input: {
      readonly operationId: string
      readonly error: unknown
    }) => void
  } & (
    | { readonly configuration: DatabaseConfigurationPort; readonly configPath?: never }
    | { readonly configuration?: never; readonly configPath?: string }
  ),
): DatabaseMigrationModule {
  const configuration =
    input.configuration ?? createFileDatabaseConfiguration(input.configPath ?? Paths.config)
  const coordinator = createDatabaseMigrationCoordinator({
    sqlitePath: input.sqlitePath ?? Paths.db,
    operationsRoot: input.operationsRoot ?? Paths.databaseMigrationsDir,
    generationPointerPath: input.generationPointerPath ?? Paths.databaseGenerationPointer,
    admission: input.admission,
    executionMode: input.executionMode,
    onBackgroundFailure: input.onBackgroundFailure,
    activateTargetConfig: (target) => configuration.write(target),
    activateSourceConfig: () => configuration.write({ provider: 'sqlite' }),
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
export function composeLocalDatabaseMigrationOperations(): LocalDatabaseMigrationOperations {
  const module = composeDatabaseMigrationModule({
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
