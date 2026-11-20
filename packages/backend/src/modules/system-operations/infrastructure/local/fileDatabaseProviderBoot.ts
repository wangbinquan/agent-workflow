// RFC-517 — the file database's boot / manual-command preparation (RFC-294 S10): the upgrade lock is taken only when a
// step asks for it and is released whatever the outcome; epoch admission runs before the provider-move recovery and the
// runtime preparation.
import { dirname } from 'node:path'
import { prepareEpoch2DatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { acquireLock } from '@/util/lock'
import type { DatabaseConfigurationPort } from '../../application/ports/databaseConfiguration'
import type {
  prepareDatabaseSchemaUpgrade,
  DatabaseSchemaUpgradeOptions,
} from '../databaseSchemaUpgradeCoordinator'
import { admitEpochBoot } from '../epochSwitch/bootAdmission'
import { recoverEpoch2ProviderMove } from './epoch2ProviderMoveRecovery'

export type FileDatabaseBootPreparation = Omit<
  DatabaseSchemaUpgradeOptions,
  'readConfig' | 'writeConfig'
> &
  (
    | { readonly configuration: DatabaseConfigurationPort; readonly configPath?: never }
    | { readonly configuration?: never; readonly configPath?: string }
  )

export type PreparedFileDatabase = Awaited<ReturnType<typeof prepareDatabaseSchemaUpgrade>>

export async function prepareFileDatabaseProviderForBoot(
  input: FileDatabaseBootPreparation,
): Promise<PreparedFileDatabase> {
  let held: ReturnType<typeof acquireLock> | undefined
  const requireUpgradeLock = () => {
    if (input.lock === undefined && held === undefined) held = acquireLock(input.lockPath)
  }
  try {
    admitEpochBoot({
      appHome: dirname(input.generationPointerPath),
      provider: input.config.provider,
    })
    await recoverEpoch2ProviderMove({ ...input, requireUpgradeLock })
    return await prepareEpoch2DatabaseProviderRuntime({ ...input, requireUpgradeLock })
  } finally {
    held?.release()
  }
}
