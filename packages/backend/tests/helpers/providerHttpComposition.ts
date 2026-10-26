import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
import { createCodeHistoryPackageReader } from '@/modules/code-capability/composition/historyQueries'
import { readActiveEpochInstallation } from '@/modules/system-operations/composition/epochInstallation'
// RFC-392: exercise the passive HTTP injection boundary with complete session modules on both engines.
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import {
  composeProviderAppComposition,
  type ProviderAppOwnerInput,
} from '@/bootstrap/daemonHttpComposition'
import { composeProviderAppDeps, createComposedApp } from '@/server'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { composeLocalExecutionAuthority } from '@/modules/system-operations/composition'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { join } from 'node:path'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { ProviderDatabaseHarness } from './eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplicationInput,
} from './providerHttpApplication'

export async function createProviderHttpCompositionFixture(
  harness: ProviderDatabaseHarness,
  input: ProviderHttpApplicationInput,
) {
  const application = await createProviderHttpApplication(harness, input)
  const configPath = input.configPath ?? join(application.appHome, 'config.json')
  const unexpected = async (): Promise<never> => {
    throw new Error('HTTP composition fixture does not migrate')
  }
  const databaseMigration = composeDatabaseMigrationModule({
    contract: logicalSchemaContract,
    configPath,
    sqlitePath: join(application.appHome, 'db.sqlite'),
    operationsRoot: join(application.appHome, 'database-migrations'),
    generationPointerPath: join(application.appHome, 'database-generation.json'),
    admission: {
      freezeAndDrain: unexpected,
      reopenSqlite: unexpected,
      activatePostgresql: unexpected,
      openPostgresqlAdmission: unexpected,
    },
    executionMode: 'inline',
  })
  const installation = await readActiveEpochInstallation(harness.db)
  const codeHistory = createCodeHistoryPackageReader({
    db: harness.db,
    content: epoch2RuntimeTestPorts(harness.db).content,
    installation: installation.history,
  })
  return {
    ...application,
    compose(overrides: Partial<ProviderAppOwnerInput<DatabaseProvider>['modules']>) {
      const modules = { ...application.modules, ...overrides }
      const http = composeProviderAppComposition({
        historyRestrictions: epoch2RuntimeTestPorts(harness.db).historyRestrictions,
        codeHistory,
        db: harness.db,
        token: input.token,
        appHome: application.appHome,
        secretBox: application.secretBox,
        dbVersion: input.dbVersion,
        opencodeVersion: input.opencodeVersion ?? null,
        applicationConfiguration:
          input.applicationConfiguration ??
          composeApplicationConfigurationBinding({ kind: 'file', configPath }),
        executionAuthority: composeLocalExecutionAuthority(),
        databaseTelemetry: () => ({
          version: 1,
          provider: harness.applicationBinding.provider,
          poolWait: null,
        }),
        daemonInfoPath: join(application.appHome, '.daemon.info'),
        databaseMigration,
        portArtifacts: composePortArtifactOperations(undefined, application.appHome),
        integrationIdentityAccess: {
          ...modules.core.identityAccess,
          integrationTriggerResources:
            modules.scheduledTasks.scheduledTaskRuntime.integrationTriggerResources,
          taskExecutionResources: modules.taskExecution.resources,
        },
        modules,
      })
      return {
        composition: http.composition,
        app: createComposedApp(composeProviderAppDeps(http.composition)),
      }
    },
  }
}
