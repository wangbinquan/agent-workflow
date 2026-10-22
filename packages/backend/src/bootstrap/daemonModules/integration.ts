import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createMissionCodeHostEventContinuation } from '@/modules/development-automation/composition'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { graphEmployeeTypePackage } from '@/modules/development-automation/composition/graphDevelopment'
import { createEmployeeAutomationWorkStartProvider } from '@/modules/digital-employee/composition'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { collaborationCommittedEventCatalogJson } from '@/modules/collaboration/public/events'
import {
  composeEventCenter,
  deferEventCenterModule,
  createEventAutomationWorkIntentStore,
} from '@/modules/event-center/composition'
import {
  createCodeHostWebhookDeliveryConsumer,
  createCodeHostWebhookRoutingDirectory,
} from '@/modules/integration/composition'
import { composeSelectedApprovalGatewayRunnerFor } from '@/modules/integration/composition/approvalGateway'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import {
  composeDevelopmentApprovalEventObserver,
  composeDevelopmentCodeHostEventObserver,
  composeDevelopmentEmployeeEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import { composeDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import { composeWebhookTriggerValidation } from '@/modules/integration/composition/webhookAdmission'
import {
  composeWebhookDispatchCore,
  composeWebhookTriggerServiceDependenciesFor,
  createWebhookDispatchExecutionRuntime,
} from '@/modules/integration/composition/webhookDispatch'
import { composeWebhookEndpointServiceDependencies } from '@/modules/integration/composition/webhookEndpoints'
import { composeWebhookDeliveryRuntimeFor } from '@/modules/integration/composition/webhookIngress'
import { composeMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import type { WorkspaceClaimFinalizationCommand } from '@/modules/source-control/public/commands'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { composeTaskSourceTermination } from '@/modules/task-execution/composition/sourceTermination'
import { createTaskAutomationWorkStartProvider } from '@/modules/task-execution/composition/taskRouteLaunch'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'
import { resolveDevelopmentRepoBinding } from '@/services/developmentDeliveryDeps'
import {
  supportsEventCenterCodeHostDelivery,
  type WebhookDispatcher,
} from '@/services/webhook/dispatcherTypes'
import {
  createWebhookDispatcher,
  type WebhookDispatchDeps,
} from '@/services/webhook/webhookDispatch'
import { createLogger } from '@/util/log'
import type { DaemonScheduledTaskModules } from './scheduledTasks'

const log = createLogger('daemon-integration')

type EventAutomationContexts = Parameters<
  typeof createTaskAutomationWorkStartProvider
>[0]['contexts'] &
  Parameters<typeof createEmployeeAutomationWorkStartProvider>[0]['contexts'] & {
    readonly factory: Extract<
      Parameters<typeof composeEventCenter>[0]['automation'],
      { readonly kind: 'automation' }
    >['delegatedContexts']
  }

export function composeDaemonIntegrationModules(input: {
  readonly db: PersistenceDb
  readonly secretBox: SecretBox
  readonly configuration: ApplicationConfigurationQueries
  readonly scheduledTaskRuntime: DaemonScheduledTaskModules['scheduledTaskRuntime']
  readonly identityAccess: WebhookDispatchDeps['identityAccess']
  // Keep the IA composition import in the roots; this bundle owns the single binding instance.
  readonly bindEventAutomationContexts: (
    delegatedRequests: WebhookDispatchDeps['identityAccess']['delegatedRequests'],
  ) => EventAutomationContexts
  readonly runtimeRegistry: NonNullable<
    Parameters<typeof composeTaskSourceTermination>[0]['runtimeRegistry']
  >
  readonly workspaceMaintenance: WorkspaceClaimFinalizationCommand
  readonly taskExecutions: Parameters<
    typeof createWebhookDispatchExecutionRuntime
  >[0]['taskExecutions']
  readonly digitalEmployeeWorkStart: Parameters<
    typeof createWebhookDispatchExecutionRuntime
  >[0]['digitalEmployeeWorkStart']
  readonly developmentDeliveryProvider: Parameters<typeof resolveDevelopmentRepoBinding>[0]
  readonly developmentPurposeRoot: {
    readonly approval: Parameters<typeof composeSelectedApprovalGatewayRunnerFor>[1]
  }
  readonly adapters?: {
    readonly customObserverPrograms?: Parameters<
      typeof composeEventCenter
    >[0]['customObserverPrograms']
    readonly beforeEventObservationWrite?: Parameters<
      typeof composeEventCenter
    >[0]['beforeObservationWrite']
    readonly crewStationEvents?: CrewStationEventIngress
    readonly webhookDispatcher?: WebhookDispatcher
    readonly webhookTerminalControl?: ReturnType<typeof composeMrTerminalControl>
  }
}) {
  // A failed physical cleanup retains its durable claim for maintenance recovery.
  // It must not turn an already-applied source termination into an endlessly retried MR job.
  const finalizeClaimedWorkspace = async (taskId: string): Promise<void> => {
    try {
      await input.workspaceMaintenance.finalizeClaimedWorkspace(taskId)
    } catch (error) {
      log.warn('MR terminal workspace cleanup failed (claim kept)', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const webhookTerminalControl =
    input.adapters?.webhookTerminalControl ??
    composeMrTerminalControl({
      db: input.db,
      taskTermination: composeTaskSourceTermination({
        db: input.db,
        runtimeRegistry: input.runtimeRegistry,
        finalizeWithoutDriver: finalizeClaimedWorkspace,
      }),
    })
  const dispatchCore = composeWebhookDispatchCore(
    input.db,
    input.secretBox,
    input.scheduledTaskRuntime.operations,
  )
  const webhookDeliveryPersistence = dispatchCore.deliveryPersistence
  const webhookDispatcher =
    input.adapters?.webhookDispatcher ??
    createWebhookDispatcher({
      ...dispatchCore,
      identityAccess: input.identityAccess,
      getDefaultRuntime: async () => (await input.configuration.read()).defaultRuntime,
      terminalControl: webhookTerminalControl,
      ...createWebhookDispatchExecutionRuntime({
        taskExecutions: input.taskExecutions,
        digitalEmployeeWorkStart: input.digitalEmployeeWorkStart,
      }),
    })
  const eventAutomationWorkIntents = createEventAutomationWorkIntentStore(input.db)
  const eventAutomationContexts = input.bindEventAutomationContexts(
    input.identityAccess.delegatedRequests,
  )
  const taskAutomationWorkStart = createTaskAutomationWorkStartProvider({
    db: input.db,
    origins: eventAutomationWorkIntents,
    contexts: eventAutomationContexts,
    resources: input.identityAccess.taskExecutionResources,
    launch: (request) => input.taskExecutions.launch(request),
  })
  const employeeAutomationWorkStart = createEmployeeAutomationWorkStartProvider({
    db: input.db,
    origins: eventAutomationWorkIntents,
    contexts: eventAutomationContexts,
    launchWork: (request) => input.digitalEmployeeWorkStart.launch(request),
  })
  const developmentApprovalGateway = composeSelectedApprovalGatewayRunnerFor(
    input.db,
    input.developmentPurposeRoot.approval,
  )
  const missionEventContinuation = createMissionCodeHostEventContinuation(input.db)
  const eventCenter = deferEventCenterModule(
    composeEventCenter({
      db: input.db,
      beforeObservationWrite: input.adapters?.beforeEventObservationWrite,
      customObserverPrograms: input.adapters?.customObserverPrograms,
      typePackageDescriptorJsons: [
        developmentEmployeeTypePackage.descriptorJson,
        graphEmployeeTypePackage.descriptorJson,
        codeHostEventCatalogJson,
        taskLifecycleEventCatalogJson,
        collaborationCommittedEventCatalogJson,
        digitalEmployeeLifecycleEventCatalogJson,
      ],
      observer: composeDevelopmentEmployeeEventObserver({
        codeHost: composeDevelopmentCodeHostEventObserver({
          binding: (repositoryId) =>
            resolveDevelopmentRepoBinding(input.developmentDeliveryProvider, repositoryId),
        }),
        approval: composeDevelopmentApprovalEventObserver({
          gateway: developmentApprovalGateway,
        }),
      }),
      routingSubscriptions: createCodeHostWebhookRoutingDirectory(
        input.db,
        missionEventContinuation,
      ),
      automation: {
        kind: 'automation',
        workIntents: eventAutomationWorkIntents,
        delegatedContexts: eventAutomationContexts.factory,
        taskWorkStart: taskAutomationWorkStart,
        employeeWorkStart: employeeAutomationWorkStart,
      },
      deliveryConsumers: supportsEventCenterCodeHostDelivery(webhookDispatcher)
        ? [
            createCodeHostWebhookDeliveryConsumer(
              input.db,
              webhookDispatcher,
              missionEventContinuation,
            ),
          ]
        : [],
      deliveryRetryLimits: {
        async current() {
          const current = await input.configuration.read()
          return {
            defaultNodeRetries: current.defaultNodeRetries,
            sessionRestartBudget: current.sessionRestartBudget,
          }
        },
      },
    }),
  )
  const webhookDeliveryRuntime = composeWebhookDeliveryRuntimeFor(input.db)
  return Object.freeze({
    webhookTerminalControl,
    webhookDispatcher,
    webhookDeliveryPersistence,
    webhookDeliveryRuntime,
    webhookIngressPersistence: webhookDeliveryRuntime,
    webhookEndpointService: composeWebhookEndpointServiceDependencies(input),
    webhookTriggerService: composeWebhookTriggerServiceDependenciesFor(
      input.db,
      composeWebhookTriggerValidation(input.scheduledTaskRuntime.operations, input.configuration),
    ),
    eventAutomationWorkIntents,
    eventAutomationContexts,
    taskAutomationWorkStart,
    employeeAutomationWorkStart,
    eventCenter,
    developmentApprovalGateway,
    developmentToolConnections: composeDevelopmentToolConnectionCatalog(input.db),
    crewStationEvents: input.adapters?.crewStationEvents,
    finalizeClaimedWorkspace,
  })
}
export type DaemonIntegrationModules = ReturnType<typeof composeDaemonIntegrationModules>
