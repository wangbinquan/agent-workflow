// RFC-381: passive bundle fixtures keep the database/provider real; unused outbound effects fail explicitly.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createSecretBoxFromKey } from '@/platform/crypto/secretBox'
import { composeDaemonScheduledTaskModules } from '@/bootstrap/daemonModules/scheduledTasks'
import { composeDaemonIntegrationModules } from '@/bootstrap/daemonModules/integration'
import { composeDaemonFusionModules } from '@/bootstrap/daemonModules/fusion'
import {
  composeIdentityAccess,
  createEventAutomationDelegatedContextBinding,
} from '@/modules/identity-access/composition'
import { composeMemoryCatalogOperations } from '@/modules/memory/composition'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { composeDevelopmentPurposeRoot } from '@/bootstrap/developmentPurposeRoot'
import { standaloneSelections } from '@/bootstrap/standalone'
import { taskExecutionResourceBinding } from './integrationTriggerResourceBinding'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'
import { createFileSkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import { createTaskExecutionTestModule } from './taskExecutionModule'
import { neverPruneTerminalWorkspaces } from '@/modules/task-execution/composition'

type IntegrationInput = Parameters<typeof composeDaemonIntegrationModules>[0]
export function integrationBundleFixture(
  db: PersistenceDb,
  appHome: string,
  overrides: Partial<
    Pick<
      IntegrationInput,
      | 'runtimeRegistry'
      | 'workspaceMaintenance'
      | 'adapters'
      | 'taskExecutions'
      // RFC-534: the session's terminal workspace prune policy (never, unless a case exercises reclamation).
      | 'terminalWorkspacePrune'
    >
  > = {},
) {
  const configuration = composeApplicationConfigurationBinding({
    kind: 'file',
    configPath: `${appHome}/config.json`,
  })

  const standalone = standaloneSelections({ appHome })
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
    terminalWorkspacePrune: neverPruneTerminalWorkspaces,
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
    developmentCodeHostBinding: {} as IntegrationInput['developmentCodeHostBinding'],
    // RFC-431: the bundle receives the standalone profile's selections.
    developmentPurposeRoot: composeDevelopmentPurposeRoot({
      selection: standalone.developmentPurposes,
      evidenceArtifacts: standalone.evidenceArtifacts,
    }),
    adapters: {
      customObserverPrograms: standalone.customObserverPrograms,
      beforeEventObservationWrite: standalone.beforeEventObservationWrite,
      crewStationEvents: standalone.crewStationEvents,
    },
    ...overrides,
  })
  const fusionModules = composeDaemonFusionModules({
    db,
    appHome,
    // RFC-525: the standalone deployment's content binding (what the standalone daemon passes).
    skillContent: createFileSkillContentBinding(db, appHome),
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
