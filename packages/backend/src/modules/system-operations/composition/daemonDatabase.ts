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
type PreparedDaemonDatabase = Awaited<ReturnType<typeof prepareDatabaseProviderForBoot>>

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
