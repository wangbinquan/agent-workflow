// RFC-370 A-T2: compatibility entry for standalone schema preparation.
// Application decisions and concrete installation effects have separate owners.
import { prepareDatabaseInstallation } from '../application/prepareDatabaseInstallation'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  createFileDatabaseInstallation,
  type DatabaseSchemaUpgradeOptions,
} from './local/fileDatabaseInstallation'

export type { DatabaseSchemaUpgradeOptions } from './local/fileDatabaseInstallation'

export async function prepareDatabaseSchemaUpgrade(options: DatabaseSchemaUpgradeOptions) {
  return await prepareDatabaseInstallation({
    config: options.config,
    contract: options.contract,
    history: options.history ?? (await loadPostgresqlMigrationHistory()),
    configuration: { read: options.readConfig, write: options.writeConfig },
    effects: createFileDatabaseInstallation(options),
  })
}
