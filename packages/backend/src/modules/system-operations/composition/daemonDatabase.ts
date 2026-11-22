// The daemon selects configuration and installation effects independently.
// The existing preparation application retains generation and recovery policy.
// RFC-524: the caller names the preparation — the deployment's selected installation or the local file
// preparation — instead of leaving the installation out.
import type { DatabaseConfigurationPort } from '../application/ports/databaseConfiguration'
import type { DatabaseInstallationPort } from '../application/ports/databaseInstallation'
import { prepareDatabaseProviderForBoot } from '../composition'

type FilePreparation = Omit<
  Parameters<typeof prepareDatabaseProviderForBoot>[0],
  'configuration' | 'configPath'
>
/** The prepared provider the daemon boots on. */
export type PreparedDaemonDatabase = Awaited<ReturnType<typeof prepareDatabaseProviderForBoot>>

/** RFC-532: what the daemon hands its database installation to prepare: the configuration port and its local files (a
 * selected installation reads the configuration and contract from them). */
export interface DaemonDatabaseBootPreparation {
  readonly configuration: DatabaseConfigurationPort
  readonly file: FilePreparation
}

export type DaemonDatabaseInstallationPort = DatabaseInstallationPort<PreparedDaemonDatabase>

interface SelectedDaemonDatabasePreparation<TPrepared> {
  readonly kind: 'selected'
  readonly configuration: DatabaseConfigurationPort
  readonly installation: DatabaseInstallationPort<TPrepared>
  readonly file: FilePreparation
}

interface FileDaemonDatabasePreparation {
  readonly kind: 'file'
  readonly configuration: DatabaseConfigurationPort
  readonly file: FilePreparation
}

export type DaemonDatabasePreparation =
  | SelectedDaemonDatabasePreparation<PreparedDaemonDatabase>
  | FileDaemonDatabasePreparation

export function prepareDaemonDatabaseProviderForBoot<TPrepared>(
  input: SelectedDaemonDatabasePreparation<TPrepared>,
): Promise<TPrepared>
export function prepareDaemonDatabaseProviderForBoot(
  input: DaemonDatabasePreparation,
): Promise<PreparedDaemonDatabase>
export async function prepareDaemonDatabaseProviderForBoot<TPrepared>(
  input: SelectedDaemonDatabasePreparation<TPrepared> | FileDaemonDatabasePreparation,
): Promise<TPrepared | PreparedDaemonDatabase> {
  if (input.kind === 'selected') {
    return await prepareDatabaseProviderForBoot({
      config: input.file.config,
      contract: input.file.contract,
      configuration: input.configuration,
      installation: input.installation,
    })
  }
  return await prepareDatabaseProviderForBoot({
    ...input.file,
    configuration: input.configuration,
  })
}
