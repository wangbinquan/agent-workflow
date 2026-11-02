// RFC-370 v2 §3.1 — the single deployment selection point.
//
// `AW_DEPLOYMENT_MODE` chooses the deployment explicitly (never inferred from
// whichever platform variables happen to be present); standalone is the
// default. A CrewStation-hosted instance runs the same start and migrate
// sequences with the hosted adapters selected here.
//
// RFC-427: the mode is read once, by `selectDeployment`; `migrate` and the two
// hosted verification commands are operations of the selected deployment, and
// an operation a deployment does not offer fails with one error type.
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { composeCrewStationRestoreNormalization, composeCrewStationProfile } from './crewstation'
import {
  composeCrewStationMigrationInstallation,
  crewStationDatabaseConfig,
  readCrewStationDatabaseEnvironment,
  prepareCrewStationDatabase,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { verifyCrewStationDatabaseRestore } from '@/modules/system-operations/composition/crewstationDatabaseRestore'
import { prepareManualDatabaseMigration } from '@/modules/system-operations/composition/manualDatabaseMigration'
import type { Deployment, DeploymentKind } from './deploymentProfile'
import { composeStandaloneProfile } from './standalone'

export type DeploymentMode = DeploymentKind

type DeploymentEnvironment = Readonly<Record<string, string | undefined>>

export class DeploymentModeError extends Error {
  constructor(value: string) {
    super(`AW_DEPLOYMENT_MODE must be "standalone" or "crewstation", got ${JSON.stringify(value)}`)
    this.name = 'DeploymentModeError'
  }
}

/** RFC-427: the one refusal for an operation the selected deployment does not offer. */
export class DeploymentOperationUnavailableError extends Error {
  constructor(operation: string, required: string) {
    super(`${operation} requires ${required} deployment`)
    this.name = 'DeploymentOperationUnavailableError'
  }
}

export function readDeploymentMode(env: DeploymentEnvironment): DeploymentMode {
  const value = env.AW_DEPLOYMENT_MODE?.trim() ?? ''
  if (value === '' || value === 'standalone') return 'standalone'
  if (value === 'crewstation') return 'crewstation'
  throw new DeploymentModeError(value)
}

/** The selected deployment; the only place that reads the deployment mode. */
export function selectDeployment(env: DeploymentEnvironment): Deployment {
  return readDeploymentMode(env) === 'standalone'
    ? standaloneDeployment()
    : crewStationDeployment(env)
}

function unavailable(operation: string, required: string): () => Promise<never> {
  return async () => {
    throw new DeploymentOperationUnavailableError(operation, required)
  }
}

function standaloneDeployment(): Deployment {
  return Object.freeze({
    kind: 'standalone',
    profile: async () => composeStandaloneProfile(),
    /** `agent-workflow migrate`: the local recovery path. */
    async migrate() {
      const { migrateCommand } = await import('./migrate')
      return await migrateCommand()
    },
    verifyDatabaseRestore: unavailable('database restore verification', 'CrewStation'),
    verifyDatabaseMigration: unavailable('database migration verification', 'CrewStation'),
  } satisfies Deployment)
}

/**
 * A hosted instance verifies its database while composing its profile, so
 * Settings are readable from it at the start of the shared boot sequence; the
 * verified runtime is then handed to that boot.
 */
function crewStationDeployment(env: DeploymentEnvironment): Deployment {
  return Object.freeze({
    kind: 'crewstation',
    profile: () => composeCrewStationProfile(env),
    migrate: () => migrateCrewStation(env),
    verifyDatabaseRestore: () => verifyCrewStationRestore(env),
    async verifyDatabaseMigration() {
      const { verifyHostedEpochSwitch } = await import('./epochMigrationHosted')
      const { composeHostedEpochJobEntry } = await import('./epochMigrationHostedEntry')
      return verifyHostedEpochSwitch(env, composeHostedEpochJobEntry(env))
    },
  } satisfies Deployment)
}

/** `agent-workflow migrate` on CrewStation: the hosted release migration Job, or a manual migration. */
async function migrateCrewStation(
  env: DeploymentEnvironment,
): Promise<{ readonly output: string }> {
  if (env.CS_DATABASE_MIGRATION_OPERATION_ID) {
    const { composeHostedEpochJobEntry } = await import('./epochMigrationHostedEntry')
    const { runHostedEpochSwitchJob, restoreHostedEpoch1Backup } =
      await import('./epochMigrationHosted')
    const deps = composeHostedEpochJobEntry(env)
    return {
      output: env.CS_DATABASE_RESTORE_REFERENCE
        ? await restoreHostedEpoch1Backup(env, deps)
        : await runHostedEpochSwitchJob(env, deps),
    }
  }
  const environment = readCrewStationDatabaseEnvironment(env)
  const prepared = await prepareManualDatabaseMigration(logicalSchemaContract, {
    kind: 'selected',
    configuration: {
      read: () => crewStationDatabaseConfig(env),
      write: () => {
        throw new Error('the CrewStation database connection is provided by the platform')
      },
    },
    installation: composeCrewStationMigrationInstallation(
      logicalSchemaContract,
      environment,
      env,
      composeCrewStationRestoreNormalization(),
    ),
  })
  try {
    return { output: prepared.describeSchemaOutcome() }
  } finally {
    await prepared.runtime.close()
  }
}

async function verifyCrewStationRestore(env: DeploymentEnvironment): Promise<string> {
  const environment = readCrewStationDatabaseEnvironment(env)
  const prepared = await prepareCrewStationDatabase({
    contract: logicalSchemaContract,
    environment,
    env,
    schema: 'verify',
  })
  await prepared.runtime.close()
  const receipt = await verifyCrewStationDatabaseRestore({
    contract: logicalSchemaContract,
    environment,
    env,
  })
  return `CS_DATABASE_RESTORE_RECEIPT=${JSON.stringify(receipt)}\n`
}
