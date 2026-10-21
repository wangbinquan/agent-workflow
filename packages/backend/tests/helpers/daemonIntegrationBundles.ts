// RFC-381: passive bundle fixtures keep the database/provider real; unused outbound effects fail explicitly.
import type { ProviderNeutralDatabase } from '@/db/query'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeDaemonScheduledTaskModules } from '@/cli/daemonModules/scheduledTasks'
import { composeDaemonIntegrationModules } from '@/cli/daemonModules/integration'
import { composeDaemonFusionModules } from '@/cli/daemonModules/fusion'
import {
  composeIdentityAccess,
  createEventAutomationDelegatedContextBinding,
} from '@/modules/identity-access/composition'
import { composeMemoryCatalogOperations } from '@/modules/memory/composition'
import { createTaskExecutionTestModule } from '@/modules/task-execution/composition'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { composeDevelopmentPurposeRoot } from '@/bootstrap/developmentPurposeRoot'
import { taskExecutionResourceBinding } from './integrationTriggerResourceBinding'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'

type IntegrationInput = Parameters<typeof composeDaemonIntegrationModules>[0]
export function integrationBundleFixture(
  db: ProviderNeutralDatabase,
  appHome: string,
  overrides: Partial<
    Pick<
      IntegrationInput,
      'runtimeRegistry' | 'workspaceMaintenance' | 'adapters' | 'taskExecutions'
    >
  > = {},
) {
  const configuration = composeApplicationConfigurationBinding({
    kind: 'file',
    configPath: `${appHome}/config.json`,
  })

  const scheduledTaskModules = composeDaemonScheduledTaskModules({
    db,
    assertAgentIntegrity: async () => {},
  })
  const identityAccess = Object.freeze({
    ...composeIdentityAccess(db),
    integrationTriggerResources:
      scheduledTaskModules.scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionResources: taskExecutionResourceBinding(db),
  })
  const integrationModules = composeDaemonIntegrationModules({
    db,
    secretBox: createSecretBoxFromKey(Buffer.alloc(32, 17)),
    configuration: configuration.queries,
    scheduledTaskRuntime: scheduledTaskModules.scheduledTaskRuntime,
    identityAccess,
    bindEventAutomationContexts: createEventAutomationDelegatedContextBinding,
    runtimeRegistry: createTaskExecutionTestModule().runtimeRegistry,
    workspaceMaintenance: { finalizeClaimedWorkspace: async () => {} },
    taskExecutions: {
      launch: async () => {
        throw new Error('unexpected test task launch')
      },
      cancel: async () => {},
    },
    digitalEmployeeWorkStart: {
      launch: async () => {
        throw new Error('unexpected test employee launch')
      },
    },
    // These tests never execute an external code-host observer.
    developmentDeliveryProvider: {} as IntegrationInput['developmentDeliveryProvider'],
    developmentPurposeRoot: composeDevelopmentPurposeRoot({ appHome }),
    ...overrides,
  })
  const fusionModules = composeDaemonFusionModules({
    db,
    appHome,
    memories: composeMemoryCatalogOperations({
      db,
      contexts: identityAccess.contexts,
      authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
    }),
    tasks: {
      launch: async () => {
        throw new Error('unexpected test fusion launch')
      },
      load: async () => null,
      collect: async () => null,
      release: async () => {},
      cancel: async () => {},
    },
  })
  return {
    scheduledTaskModules,
    integrationModules,
    fusionModules,
    identityAccess,
    configuration,
  }
}
