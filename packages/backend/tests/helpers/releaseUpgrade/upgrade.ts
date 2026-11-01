import { composeAutomaticUpgradeProvisioning } from '@/bootstrap/epochMigrationAuto'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
// RFC-398 §7.3: the same automatic application as the CLI, and the real daemon preparation entry.
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeLocalEpochSwitchDependencies } from '@/bootstrap/epochMigration'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { loadConfig } from '@/config'
import {
  autoUpgrade,
  createAutoUpgradeRecords,
  createAutoUpgradeSessionLock,
  createEpochSwitchApplication,
  createLegacyMigrationFinalize,
} from '@/modules/system-operations/composition/epochMigration'
import { prepareDaemonDatabaseProviderForBoot } from '@/modules/system-operations/composition/daemonDatabase'
import { parseEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { equal, invariant } from './data'
import type { BuiltRelease } from './build'
import type { SourceCensus } from './source'
import { supplyMatrixInputs } from './fixtureInputs'
import type { Snapshot } from './data'

export async function automaticUpgrade(built: BuiltRelease, expected: { rows: Snapshot }) {
  const appHome = built.home,
    env = built.env,
    config = loadConfig(join(appHome, 'config.json'))
  const lock = createAutoUpgradeSessionLock({
    appHome,
    startMonitor: (onTick) =>
      startMaintenanceTicker({
        job: 'auto-upgrade-lock',
        intervalMs: 1000,
        phaseOffsetMs: 1000,
        keepAlive: true,
        onTick,
      }),
  })
  const records = createAutoUpgradeRecords(appHome)
  const provisioning =
    config.database.provider === 'postgresql'
      ? composeAutomaticUpgradeProvisioning({
          appHome,
          env,
          config: config.database,
          sourceProfileRef: 'env:RFC398_URL',
          async recordProvisioned(receipt) {
            await records.append(receipt.sessionOperationId, 'provisioned', { ...receipt })
          },
        })
      : undefined
  const epoch = composeLocalEpochSwitchDependencies({
    appHome,
    env,
    config,
    head: persistenceHead(),
    catalogArtifacts: persistencePostgresqlCatalogs(),
    autoUpgrade: true,
    sessionLock: lock,
    autoUpgradeRecords: records,
    nextTargetLocation: provisioning?.nextTargetLocation,
  })
  let census: SourceCensus | undefined
  supplyMatrixInputs(epoch, built, expected, (value) => {
    census = value
  })
  const result = await autoUpgrade({
    epoch,
    application: createEpochSwitchApplication(epoch),
    records,
    lock,
    legacy: createLegacyMigrationFinalize({ appHome, env }),
    provisioning,
    enabled: config.autoEpochMigration !== false,
    standalone: true,
  })
  equal(result.outcome, 'done', `auto-upgrade ${JSON.stringify(result)}`)
  invariant(result.operationId, 'automatic operation ID missing')
  const journal = parseEpochSwitchJournal(
    readFileSync(
      join(appHome, 'database-migrations', result.operationId, 'epoch-switch.json'),
      'utf8',
    ),
  )
  equal(journal.payload.phase, 'verified', 'strict checks must precede daemon writes')
  invariant(census, 'conversion input was not observed')
  return { journal, census }
}

export function epochOperations(home: string): string[] {
  const root = join(home, 'database-migrations')
  return existsSync(root)
    ? readdirSync(root)
        .filter((name) => /^dbm_e2_/.test(name))
        .sort()
    : []
}
export async function prepareNativeHistory(built: BuiltRelease): Promise<void> {
  const configPath = join(built.home, 'config.json')
  const config = loadConfig(configPath)
  const initial = epochOperations(built.home)
  const prepared = await prepareDaemonDatabaseProviderForBoot({
    configuration: {
      read: () => loadConfig(configPath).database,
      write(database) {
        writeFileSync(configPath, JSON.stringify({ ...loadConfig(configPath), database }))
      },
    },
    file: {
      config: config.database,
      sqlitePath: built.sourcePath,
      generationPointerPath: join(built.home, 'database-generation.json'),
      operationsRoot: join(built.home, 'database-migrations'),
      contract: logicalSchemaContract,
      env: built.env,
      lockPath: join(built.home, '.daemon.lock'),
      backupOnMigration: false,
      sqliteOptions: {},
    },
  })
  await prepared.runtime.close()
  equal(
    epochOperations(built.home),
    initial,
    'native preparation must not create epoch conversions',
  )
}
