import { createPostgresqlProvisioning } from '@/platform/persistence/migration/postgresqlProvisioning'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { startMaintenanceTicker } from '@/platform/background/maintenanceTicker'
// CLI-only automatic migration composition. daemonStart invokes this through the child CLI.
import { join } from 'node:path'
import { writeSync } from 'node:fs'
import { loadConfig } from '@/config'
import { Paths } from '@/platform/configuration/installationPaths'
import { appVersion } from '@/platform/execution/version'
import { createMigrationProgressReporter } from '@/platform/persistence/migration/run/progress'
import { errorText } from '@/platform/persistence/migration/errorText'
import { createSourceWatch } from '@/platform/persistence/migration/freeze/sourceWatch'
import {
  checkHomeConfig,
  createAutoUpgradeEnvironment,
  environmentRefusalConclusion,
  homeConfigRefusal,
  lockOutOfSpaceRefusal,
  readHomeConfigFile,
  unloadableConfigRefusal,
} from '@/modules/system-operations/composition/epochAutoUpgrade'
import {
  autoUpgrade,
  createAutoUpgradeRecords,
  createAutoUpgradeSessionLock,
  createLegacyMigrationFinalize,
  createAutoUpgradeProvisioning,
  readEpochTargetEvidence,
  createEpochSwitchApplication,
  autoUpgradeTestCheckpoint,
  autoUpgradeTestFailure,
  EpochSwitchError,
} from '@/modules/system-operations/composition/epochMigration'
import { composeLocalEpochSwitchDependencies } from './epochMigration'
import { persistenceHead, persistencePostgresqlCatalogs } from './persistenceHead'
import type { AutoUpgradeConclusion } from '@/modules/system-operations/public/types'

export function composeAutomaticUpgradeProvisioning(
  input: Omit<Parameters<typeof createPostgresqlProvisioning>[0], 'readTargetEvidence'>,
) {
  return createAutoUpgradeProvisioning(
    createPostgresqlProvisioning({ ...input, readTargetEvidence: readEpochTargetEvidence }),
  )
}

/** RFC-398 §3: the one native provisioner selection; SQLite creates no database. Both the
 * automatic session and the `db migration` command (status `retainedDatabases`) use it. */
export function automaticUpgradeProvisioning(input: {
  readonly appHome: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly database: ReturnType<typeof loadConfig>['database']
  readonly recordProvisioned?: Parameters<
    typeof composeAutomaticUpgradeProvisioning
  >[0]['recordProvisioned']
}) {
  const { database } = input
  // SQLite creates its own file during activation; only a server database is provisioned.
  if (database.provider === 'sqlite') return undefined
  if (database.provider !== 'postgresql') return unhandledDatabaseProvider(database)
  return composeAutomaticUpgradeProvisioning({
    appHome: input.appHome,
    env: input.env,
    config: database,
    sourceProfileRef: `env:${database.urlEnv}`,
    ...(input.recordProvisioned ? { recordProvisioned: input.recordProvisioned } : {}),
  })
}

function progressLine(line: string) {
  try {
    writeSync(2, line)
  } catch (error) {
    // A SIGKILLed delegating parent closes its pipe; its child still finishes the session.
    if (!['EPIPE', 'EIO'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

export async function runAutomaticEpochUpgrade(
  input: {
    retry?: boolean
    appHome?: string
    env?: Readonly<Record<string, string | undefined>>
    /** Replaceable so tests can stand in for a disk on which the lock file cannot be written. */
    createSessionLock?: typeof createAutoUpgradeSessionLock
  } = {},
): Promise<AutoUpgradeConclusion> {
  const appHome = input.appHome ?? Paths.root
  const env = input.env ?? process.env
  const lock = (input.createSessionLock ?? createAutoUpgradeSessionLock)({
    appHome,
    startMonitor: (onTick) =>
      startMaintenanceTicker({
        job: 'auto-upgrade-lock',
        intervalMs: 1000,
        phaseOffsetMs: 1000,
        keepAlive: true,
        onTick,
      }),
    delegation: env.AGENT_WORKFLOW_EPOCH_LOCK_DELEGATION,
  })
  // Publish active.json / validate delegation before configuration, classification or DB work.
  try {
    await lock.acquire()
  } catch (error) {
    // RFC-626 §3.5: the lock file is the first thing an upgrade writes, so on a disk without
    // any free space this is where it fails. That is reported as the lack of space it is,
    // like the other refusals of the environment; nothing has been recorded.
    const refusal = lockOutOfSpaceRefusal({
      code: (error as NodeJS.ErrnoException | null)?.code ?? null,
      error: errorText(error),
      availableBytes: await createAutoUpgradeEnvironment().availableBytes(appHome),
      directory: appHome,
    })
    if (!refusal) throw error
    return environmentRefusalConclusion(refusal)
  }
  // RFC-626 §4.1: one watch for the whole session. Planning closes its source handle and the
  // execution step opens another; a connection that is closed and opened again reports a
  // data version that cannot be compared with the earlier one, so the session keeps it.
  const sourceWatch = createSourceWatch()
  try {
    // RFC-626 §3.5: the configuration as the conversion would judge it. A file the conversion
    // would reject is reported in seconds and before anything is recorded, instead of in the
    // middle of the conversion — for a new session only, as every check before one: the
    // session judges it first (`homeConfigRefusal`). An installation that is already upgraded
    // and a session that resumes go on as long as the configuration loads (gate G4-5).
    const configPath = join(appHome, 'config.json')
    const invalid = homeConfigRefusal(configPath, checkHomeConfig(readHomeConfigFile(configPath)))
    let config: ReturnType<typeof loadConfig>
    try {
      config = loadConfig(configPath)
    } catch (error) {
      // Nothing below can be assembled without the configuration, whatever the session.
      await autoUpgradeTestCheckpoint('environment-refused')
      return environmentRefusalConclusion(
        invalid ?? unloadableConfigRefusal(configPath, errorText(error)),
      )
    }
    const records = createAutoUpgradeRecords(appHome)
    const provisioning = automaticUpgradeProvisioning({
      appHome,
      env,
      database: config.database,
      async recordProvisioned(receipt) {
        const session = (await records.list()).find(
          (s) => s.operationId === receipt.sessionOperationId,
        )
        if (
          !session?.records.some((r) => r.kind === 'provisioned' && r.data.runId === receipt.runId)
        )
          await records.append(receipt.sessionOperationId, 'provisioned', { ...receipt })
      },
    })
    const epoch = composeLocalEpochSwitchDependencies({
      appHome,
      config,
      env,
      head: persistenceHead(),
      catalogArtifacts: persistencePostgresqlCatalogs(),
      candidateBuild: env.AGENT_WORKFLOW_BUILD ?? env.AGENT_WORKFLOW_VERSION ?? appVersion(),
      autoUpgrade: true,
      sourceWatch,
      sessionLock: lock,
      autoUpgradeRecords: records,
      retainedDatabases: provisioning?.retained,
      autoUpgradeCheckpoint: autoUpgradeTestCheckpoint,
      nextTargetLocation: provisioning?.nextTargetLocation,
      progress: createMigrationProgressReporter(progressLine),
    })
    if (env.AGENT_WORKFLOW_TEST_EPOCH_UPGRADE) {
      // Test-only faults supplement the real acceptance probes; no production probe is removed.
      epoch.acceptanceProbes = [
        ...(epoch.acceptanceProbes ?? epoch.probes ?? []),
        {
          id: 'rfc398-test-acceptance',
          async run() {
            await autoUpgradeTestCheckpoint('verify-called')
            return {
              id: 'rfc398-test-acceptance',
              passed: !autoUpgradeTestFailure('negative-health'),
              detail: null,
            }
          },
        },
      ]
      const freeze = epoch.sourceFor!
      epoch.sourceFor = (journal) => {
        const source = freeze(journal)
        return {
          ...source,
          async freeze(request) {
            if (journal.payload.frozen && autoUpgradeTestFailure('source-changed'))
              throw new EpochSwitchError('v3-source-changed', { category: 'source-changed' })
            return source.freeze(request)
          },
        }
      }
    }
    return await autoUpgrade(
      {
        epoch,
        application: createEpochSwitchApplication(epoch),
        records,
        lock,
        legacy: createLegacyMigrationFinalize({ appHome, env }),
        provisioning,
        environment: createAutoUpgradeEnvironment(),
        homeConfigRefusal: invalid,
        enabled: config.autoEpochMigration !== false,
        standalone: !env.AW_DEPLOYMENT_MODE || env.AW_DEPLOYMENT_MODE === 'standalone',
        log: (line, warning) => progressLine(`${warning ? 'WARN ' : ''}${line}\n`),
      },
      input,
    )
  } finally {
    // The session is over however it ended: completed, refused or failed.
    try {
      sourceWatch.close()
    } finally {
      await lock.release()
    }
  }
}
