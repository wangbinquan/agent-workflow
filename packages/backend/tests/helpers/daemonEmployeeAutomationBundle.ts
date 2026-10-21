// RFC-383: real session bundles on each provider; no daemon, timers or external services.
import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeDaemonProviderCore } from '@/bootstrap/daemonModules/providerCore'
import { DAEMON_PROVIDER_CORE_ADAPTERS } from '@/bootstrap/daemonModules/adapters'
import { composeDaemonRepositoryCredentials } from '@/bootstrap/daemonModules/repositoryCredentials'
import { composeDaemonIntegrationModules } from '@/bootstrap/daemonModules/integration'
import { composeDaemonScheduledTaskModules } from '@/bootstrap/daemonModules/scheduledTasks'
import {
  composeDaemonDigitalEmployeeModules,
  type DaemonDigitalEmployeeInput,
} from '@/bootstrap/daemonModules/digitalEmployee'
import { composeDaemonDevelopmentAutomationModules } from '@/bootstrap/daemonModules/developmentAutomation'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { createEventAutomationDelegatedContextBinding } from '@/modules/identity-access/composition'
import { selectDevelopmentWorkspaceEffectBinding } from '@/modules/development-automation/composition'
import { composeDevelopmentPurposeRoot } from '@/bootstrap/developmentPurposeRoot'
import { taskBundleInput } from './daemonTaskExecutionBundle'
import type { ProviderDatabaseHarness } from './eachProvider'

export function employeeAutomationFixture(harness: ProviderDatabaseHarness, appHome: string) {
  const binding = harness.applicationBinding,
    db = harness.db
  const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 8))
  const adapters =
    binding.provider === 'sqlite'
      ? DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({ db: binding.db, appHome, secretBox })
      : DAEMON_PROVIDER_CORE_ADAPTERS.postgresql({
          db: binding.db,
          runtime: binding.runtime,
          databaseConfig: binding.databaseConfig,
          appHome,
        })
  const core = composeDaemonProviderCore({
    sourceWriteWindow: ALWAYS_WRITABLE_DATABASE_SOURCE,
    db,
    appHome,
    secretBox,
    daemonToken: 'rfc383',
    adapters,
    realtimePolicy: {
      resourceVisibility: { canViewResource: async () => false },
      memoryVisibility: { canViewMemory: async () => false },
      repoImportOwnerUserId: () => null,
      redactTaskEventPayload: (p) => p,
    },
    onCredentialRevoked() {},
    identityEvents: { authorityRevisionChanged() {} },
    presenceProjection: { publish() {} },
  })
  const tasks = taskBundleInput(harness, appHome)
  const taskExecution = tasks.compose()
  const developmentPurposeRoot = composeDevelopmentPurposeRoot({ appHome })
  const repository = composeDaemonRepositoryCredentials({
    db,
    appHome,
    secretBox,
    developmentPurposeRoot,
    repositoryWorkspaceStore: core.repositoryWorkspaceStore,
    repositoryWorkspaceOperations: core.repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository: core.repositoryTransportCredentialRepository,
  })
  const scheduled = composeDaemonScheduledTaskModules({
    db,
    assertAgentIntegrity: (ids) =>
      tasks.resourceCatalog.agentResourceIntegrity.launch.assertUsable({ rootAgentIds: ids }),
  })
  const integration = composeDaemonIntegrationModules({
    db,
    secretBox,
    configuration: { read: async () => DEFAULT_CONFIG },
    scheduledTaskRuntime: scheduled.scheduledTaskRuntime,
    identityAccess: {
      ...core.identityAccess,
      integrationTriggerResources: scheduled.scheduledTaskRuntime.integrationTriggerResources,
      taskExecutionResources: taskExecution.resources,
    },
    bindEventAutomationContexts: createEventAutomationDelegatedContextBinding,
    runtimeRegistry: taskExecution.executionModule.runtimeRegistry,
    workspaceMaintenance: composeWorkspaceMaintenanceCommand({
      db,
      appHome,
      terminalMaintenance: taskExecution.persistence.terminalMaintenance,
      isMaterializingTask: () => false,
      invalidateWorkspacePath() {},
    }),
    taskExecutions: taskExecution.trigger.taskExecutions,
    digitalEmployeeWorkStart: { launch: (request) => employee.workStart.launch(request) },
    developmentDeliveryProvider: repository.developmentDeliveryProvider,
    developmentPurposeRoot,
  })
  const workspaceEffects = selectDevelopmentWorkspaceEffectBinding({
    conflictWorkspaceSelected: false,
  })
  const employeeInput: DaemonDigitalEmployeeInput = {
    db,
    appHome,
    configuration: { read: async () => DEFAULT_CONFIG },
    log: { info() {}, warn() {} },
    core: {
      daemonActor: core.daemonActor,
      userDirectory: core.identityAccess.userDirectory,
      directAuthority: core.identityAccess.directAuthority,
    },
    resources: tasks.resourceCatalog,
    repository,
    integration,
    taskExecution,
    developmentPurposeRoot,
    workspaceEffects,
  }
  const employee = composeDaemonDigitalEmployeeModules(employeeInput)
  const automationInput = {
    db,
    appHome,
    log: employeeInput.log,
    repository,
    integration,
    hostTasks: taskExecution.hostTasks,
    writerCutover: employee.writerCutover,
    developmentPurposeRoot,
    workspaceEffects,
  }
  return {
    core,
    tasks,
    taskExecution,
    employeeInput,
    employee,
    automationInput,
    automation: composeDaemonDevelopmentAutomationModules(automationInput),
  }
}
