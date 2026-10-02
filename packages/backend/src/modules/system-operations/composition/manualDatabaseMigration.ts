// Manual recovery chooses the same neutral installation/configuration ports
// as daemon boot. Local paths remain in the explicit file preparation branch.
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'
import type { DatabaseConfigurationPort } from '../application/ports/databaseConfiguration'
import type { DatabaseInstallationPort } from '../application/ports/databaseInstallation'
import { createFileDatabaseConfiguration } from '../infrastructure/local/fileDatabaseConfiguration'
import { prepareDatabaseProviderForBoot } from '../composition'

/** Only the prepared provider's lifetime and description reach the CLI. */
type ManualMigrationRuntime = {
  [Provider in DatabaseProvider]: {
    readonly provider: Provider
    close(): void | Promise<void>
  }
}[DatabaseProvider]

export interface PreparedManualDatabaseMigration {
  readonly runtime: ManualMigrationRuntime
  describeSchemaOutcome(): string
}

export type ManualDatabaseMigrationOptions =
  | {
      readonly kind: 'selected'
      readonly configuration: DatabaseConfigurationPort
      readonly installation: DatabaseInstallationPort<PreparedManualDatabaseMigration>
    }
  | {
      readonly kind: 'file'
      readonly configuration?: DatabaseConfigurationPort
    }

export async function prepareManualDatabaseMigration(
  options: ManualDatabaseMigrationOptions = { kind: 'file' },
): Promise<PreparedManualDatabaseMigration> {
  const configuration = options.configuration ?? createFileDatabaseConfiguration(Paths.config)
  // Retain the original read-before-contract/preparation ordering. Recovery
  // receives this same instance for its later provider activation/re-read.
  const config = await configuration.read()
  const contract = buildLogicalSchemaContract()
  if (options.kind === 'selected') {
    return await prepareDatabaseProviderForBoot({
      config,
      contract,
      configuration,
      installation: options.installation,
    })
  }
  return await prepareDatabaseProviderForBoot({
    config,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
    configuration,
    lockPath: Paths.lock,
    sqliteOptions: { migrationsFolder: await resolveMigrationsFolder() },
  })
}
