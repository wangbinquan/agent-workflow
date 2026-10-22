// RFC-370 v2 §3.1 — the single deployment selection point.
//
// `AW_DEPLOYMENT_MODE` chooses the deployment explicitly (never inferred from
// whichever platform variables happen to be present); standalone is the
// default. A CrewStation-hosted instance runs the same start and migrate
// sequences with the hosted adapters selected here.
import { composeCrewStationRestoreNormalization, composeCrewStationProfile } from './crewstation'
import {
  composeCrewStationMigrationInstallation,
  crewStationDatabaseConfig,
  readCrewStationDatabaseEnvironment,
  prepareCrewStationDatabase,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { verifyCrewStationDatabaseRestore } from '@/modules/system-operations/composition/crewstationDatabaseRestore'
import { prepareManualDatabaseMigration } from '@/modules/system-operations/composition/manualDatabaseMigration'
import type { DeploymentProfile, DeploymentKind } from './deploymentProfile'
import { composeStandaloneProfile } from './standalone'

export type DeploymentMode = DeploymentKind

export class DeploymentModeError extends Error {
  constructor(value: string) {
    super(`AW_DEPLOYMENT_MODE must be "standalone" or "crewstation", got ${JSON.stringify(value)}`)
    this.name = 'DeploymentModeError'
  }
}

export function readDeploymentMode(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentMode {
  const value = env.AW_DEPLOYMENT_MODE?.trim() ?? ''
  if (value === '' || value === 'standalone') return 'standalone'
  if (value === 'crewstation') return 'crewstation'
  throw new DeploymentModeError(value)
}

/**
 * Profile of the selected deployment. A hosted instance verifies its
 * database first, so Settings are readable from it at the start of the shared
 * boot sequence; the verified runtime is then handed to that boot.
 */
export async function selectDeploymentProfile(
  env: Readonly<Record<string, string | undefined>>,
): Promise<DeploymentProfile> {
  if (readDeploymentMode(env) === 'standalone') return composeStandaloneProfile()
  return composeCrewStationProfile(env)
}

/** `agent-workflow migrate`: the hosted release migration Job, or the local recovery path. */
export async function migrateForDeployment(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly output: string }> {
  if (readDeploymentMode(env) === 'standalone') {
    const { migrateCommand } = await import('./migrate')
    return await migrateCommand()
  }
  const environment = readCrewStationDatabaseEnvironment(env)
  const prepared = await prepareManualDatabaseMigration({
    kind: 'selected',
    configuration: {
      read: () => crewStationDatabaseConfig(env),
      write: () => {
        throw new Error('the CrewStation database connection is provided by the platform')
      },
    },
    installation: composeCrewStationMigrationInstallation(
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

export async function verifyDatabaseRestoreForDeployment(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (readDeploymentMode(env) !== 'crewstation')
    throw new Error('database restore verification requires CrewStation deployment')
  const environment = readCrewStationDatabaseEnvironment(env)
  const prepared = await prepareCrewStationDatabase({ environment, env, schema: 'verify' })
  await prepared.runtime.close()
  const receipt = await verifyCrewStationDatabaseRestore({ environment, env })
  return `CS_DATABASE_RESTORE_RECEIPT=${JSON.stringify(receipt)}\n`
}
