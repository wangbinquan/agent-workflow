import { createPostgresqlProvisioning } from '@/platform/persistence/migration/postgresqlProvisioning'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
// CLI-only automatic migration composition. daemonStart invokes this through the child CLI.
import { join } from 'node:path'
import { writeSync } from 'node:fs'
import { loadConfig } from '@/config'
import { Paths } from '@/util/paths'
import { appVersion } from '@/util/version'
import { createMigrationProgressReporter } from '@/platform/persistence/migration/run/progress'
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
  } = {},
): Promise<AutoUpgradeConclusion> {
  const appHome = input.appHome ?? Paths.root
  const env = input.env ?? process.env
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
    delegation: env.AGENT_WORKFLOW_EPOCH_LOCK_DELEGATION,
  })
  // Publish active.json / validate delegation before configuration, classification or DB work.
  await lock.acquire()
  try {
    const config = loadConfig(join(appHome, 'config.json'))
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
        enabled: config.autoEpochMigration !== false,
        standalone: !env.AW_DEPLOYMENT_MODE || env.AW_DEPLOYMENT_MODE === 'standalone',
        log: (line, warning) => progressLine(`${warning ? 'WARN ' : ''}${line}\n`),
      },
      input,
    )
  } finally {
    await lock.release()
  }
}
