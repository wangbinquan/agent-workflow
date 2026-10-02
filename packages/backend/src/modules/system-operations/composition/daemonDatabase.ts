// The daemon selects configuration and installation effects independently.
// The existing preparation application retains generation and recovery policy.
import type { DatabaseConfigurationPort } from '../application/ports/databaseConfiguration'
import type { DatabaseInstallationPort } from '../application/ports/databaseInstallation'
import { prepareDatabaseProviderForBoot } from '../composition'

type FilePreparation = Omit<
  Parameters<typeof prepareDatabaseProviderForBoot>[0],
  'configuration' | 'configPath'
>
type PreparedDaemonDatabase = Awaited<ReturnType<typeof prepareDatabaseProviderForBoot>>

export type DaemonDatabaseInstallationPort = DatabaseInstallationPort<PreparedDaemonDatabase>

export function prepareDaemonDatabaseProviderForBoot<TPrepared>(input: {
  readonly configuration: DatabaseConfigurationPort
  readonly installation: DatabaseInstallationPort<TPrepared>
  readonly file: FilePreparation
}): Promise<TPrepared>
export function prepareDaemonDatabaseProviderForBoot(input: {
  readonly configuration: DatabaseConfigurationPort
  readonly installation?: DaemonDatabaseInstallationPort
  readonly file: FilePreparation
}): Promise<PreparedDaemonDatabase>
export async function prepareDaemonDatabaseProviderForBoot<TPrepared>(input: {
  readonly configuration: DatabaseConfigurationPort
  readonly installation?: DatabaseInstallationPort<TPrepared>
  readonly file: FilePreparation
}): Promise<TPrepared | PreparedDaemonDatabase> {
  if (input.installation !== undefined) {
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
