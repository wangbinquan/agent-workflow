// RFC-370 v2 §3.1 — the single deployment selection point.
//
// `AW_DEPLOYMENT_MODE` chooses the deployment explicitly (never inferred from
// whichever platform variables happen to be present); standalone is the
// default. A CrewStation-hosted instance runs the same start and migrate
// sequences with the hosted adapters selected here.
import { composeCrewStationCredentialAdapters } from '@/modules/identity-access/composition/authentication'
import { composeCrewStationResourceContent } from '@/modules/resource-catalog/composition/skillContentBinding'
import {
  composeCrewStationMigrationInstallation,
  composeCrewStationSystemSelections,
  crewStationDatabaseConfig,
  prepareCrewStationDatabase,
  readCrewStationDatabaseEnvironment,
  readCrewStationEnvironment,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { prepareManualDatabaseMigration } from '@/modules/system-operations/composition/manualDatabaseMigration'
import type { StartOptions } from './start'

export type DeploymentMode = 'standalone' | 'crewstation'

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
 * Start options of the selected deployment. A hosted instance verifies its
 * database first, so Settings are readable from it at the start of the shared
 * boot sequence; the verified runtime is then handed to that boot.
 */
export async function composeDeploymentStartOptions(
  env: Readonly<Record<string, string | undefined>>,
): Promise<StartOptions> {
  if (readDeploymentMode(env) === 'standalone') return {}
  const environment = readCrewStationEnvironment(env)
  const prepared = await prepareCrewStationDatabase({ environment, schema: 'verify', env })
  const system = composeCrewStationSystemSelections({ environment, prepared })
  const resources = composeCrewStationResourceContent({ db: prepared.openBootstrapClient() })
  return {
    host: '0.0.0.0',
    port: environment.port,
    applicationConfiguration: system.applicationConfiguration,
    databaseInstallation: system.databaseInstallation,
    executionAuthority: system.executionAuthority,
    secretBox: system.secretBox,
    credentials: composeCrewStationCredentialAdapters({
      jwksUrl: environment.jwksUrl,
      project: environment.project,
      service: environment.service,
      administratorSubjects: environment.adminSubjects,
    }),
    executionHost: 'remote',
    skillContent: resources.skillContent,
    resourcePackageSkillContent: resources.resourcePackageSkillContent,
    pluginInstaller: resources.pluginInstaller,
    resourcePackageSkillArtifacts: resources.resourcePackageSkillArtifacts,
    resourcePackagePluginArtifacts: resources.resourcePackagePluginArtifacts,
  }
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
      read: () => crewStationDatabaseConfig(),
      write: () => {
        throw new Error('the CrewStation database connection is provided by the platform')
      },
    },
    installation: composeCrewStationMigrationInstallation(environment, env),
  })
  try {
    return { output: prepared.describeSchemaOutcome() }
  } finally {
    await prepared.runtime.close()
  }
}
