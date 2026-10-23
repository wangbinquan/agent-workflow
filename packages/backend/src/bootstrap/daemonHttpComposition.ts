// RFC-392: passive HTTP composition from the application graph's session bundles.
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { type DaemonIntentModules } from '@/bootstrap/daemonModules/intent'
import { type DaemonDigitalEmployeeModules } from '@/bootstrap/daemonModules/digitalEmployee'
import { type DaemonDevelopmentAutomationModules } from '@/bootstrap/daemonModules/developmentAutomation'
import { type DaemonTaskExecutionModules } from '@/bootstrap/daemonModules/taskExecution'
import { type DaemonScheduledTaskModules } from '@/bootstrap/daemonModules/scheduledTasks'
import { type DaemonIntegrationModules } from '@/bootstrap/daemonModules/integration'
import { type DaemonFusionModules } from '@/bootstrap/daemonModules/fusion'
import { type DaemonMemoryModules } from '@/bootstrap/daemonModules/memory'
import { type DaemonObservationModules } from '@/bootstrap/daemonModules/observation'
import { type SelectedDaemonProviderCore } from '@/bootstrap/daemonModules/providerCore'
import { type DaemonRepositoryCredentials } from '@/bootstrap/daemonModules/repositoryCredentials'
import { type DaemonResourceCatalogModules } from '@/bootstrap/daemonModules/resourceCatalog'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeClarifyFollowupGenerator } from '@/modules/task-execution/composition/clarifyFollowupGenerator'
import type {
  PortArtifactOperations,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import { composeTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'
import { composeRunObservation } from '@/modules/run-observability/composition/runObservation'
import type { RuntimeProfileConfigurationCommands } from '@/modules/runtime-management/public/commands'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeWebhookIngressTransport } from '@/modules/integration/composition/webhookIngress'
import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'
import { selectDaemonRuntimeQueries } from '@/modules/system-operations/composition/daemonHostLifecycle'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import { type ApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { DatabaseRuntimeTelemetry, MaintenanceStatus } from '@agent-workflow/shared'
import { type Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { directOperationAuthority, directRequestAuthority } from '@/routes/operationAuthority'
import { type ConfigConcurrencyHotApplyCommand } from '@/routes/config'
import type { CommandContext } from '@/modules/identity-access/public/participants'
import {
  composeWorkgroupTaskRoom,
  composeWorkgroupTaskRoomActiveUsers,
  composeWorkgroupTaskRoomDynamicWorkflow,
} from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import { type DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { composeOidcIdentityOperations } from '@/modules/identity-access/composition/providerOperations'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { createOidcProvidersService } from '@/services/oidcProviders'
import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'
import {
  composeRepositoryMirrors,
  createFileWorkspaceContentEffects,
  createWorkspaceContentScope,
  type WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import type { ResourcePackageApplyActivityQuery } from '@/modules/resource-catalog/public/queries'
import { resolveCollaborationTaskAccess } from '@/modules/collaboration/public/queries'
import { composeResourceCatalogOverviewQuery } from '@/modules/resource-catalog/composition/resourceCatalogOverview'
import { composeSystemOverviewQuery } from '@/modules/system-operations/composition/overview'
import { composeRuntimeProbeConfigFence } from '@/modules/runtime-management/composition/runtimeManagement'
import { ForbiddenError, NotFoundError } from '@/util/errors'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composeLegacyCodeReadProviders } from '@/modules/code-capability/composition/legacyCodeReads'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/composition/codeReviewArtifacts'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import { createCollaborationTaskAccessPort } from '@/modules/collaboration/composition'
import { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { createResourcePackagePluginInstaller } from '@/services/resourcePackage/pluginInstallerAdapter'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
  type ResourcePackageSkillArtifactOwner,
  type ResourcePackagePluginArtifactOwner,
  type SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createResourcePackageAtomicApplyOperations } from '@/modules/resource-catalog/composition/resourcePackageAtomicApply'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { setChildTaskBudgetCapacity } from '@/services/execution/childBudget'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { listDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import type {
  IntegrationTriggerIdentityAccess,
  ProviderResourceCatalogRouteComposition,
  ProviderSourceControlRouteComposition,
  ProviderMemoryRouteComposition,
  ProviderAppCompositionInput,
} from '@/server'

/** Named production entry points keep provider selection explicit at bootstrap. */
export interface ProviderAppOwnerInput<P extends DatabaseProvider> {
  readonly db: PersistenceDb
  readonly token: string
  readonly appHome: string
  readonly secretBox: SecretBox
  readonly dbVersion: number
  readonly opencodeVersion: string | null
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly executionAuthority: ExecutionAuthorityPort
  readonly databaseTelemetry: () => DatabaseRuntimeTelemetry
  readonly maintenanceStatus?: () => MaintenanceStatus
  readonly daemonRuntime?: DaemonRuntimeQueries
  readonly daemonInfoPath: string
  readonly databaseMigration: DatabaseMigrationModule
  readonly portArtifacts: PortArtifactOperations
  readonly integrationIdentityAccess: IntegrationTriggerIdentityAccess
  readonly modules: Readonly<{
    core: SelectedDaemonProviderCore<P>
    repository: DaemonRepositoryCredentials
    resourceCatalog: DaemonResourceCatalogModules
    observation: DaemonObservationModules
    memory: DaemonMemoryModules
    taskExecution: DaemonTaskExecutionModules<P>
    scheduledTasks: DaemonScheduledTaskModules
    integration: DaemonIntegrationModules
    fusion: DaemonFusionModules
    digitalEmployee: DaemonDigitalEmployeeModules
    developmentAutomation: DaemonDevelopmentAutomationModules
    intent: DaemonIntentModules
  }>
  readonly selections?: Readonly<{
    resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
    resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
    resourcePackageSkillContent?: SkillPackageContentReader
    workspaceContent?: WorkspaceContentEffectsFactory
    runtimeInventoryContent?: TaskRuntimeInventoryContent
    repositoryRevisionContent?: ReturnType<typeof composeLocalRepositoryRevisionContent>
    codeReviewArtifacts?: ReturnType<typeof composeLocalCodeReviewArtifacts>
    repositoryRemote?: NonNullable<Parameters<typeof composeRepositoryMirrors>[0]['remote']>
  }>
  readonly testSeams?: Readonly<{
    workflowRuntime?: ProviderResourceCatalogRouteComposition['workflows']['runtime']
    codeHostRuntime?: ProviderSourceControlRouteComposition['codeHosts']['deps']
    buildScheduleLaunch?: BuildScheduleLaunch
  }>
}

/** Passive HTTP owners; the caller has already constructed all twelve session bundles. */
export function composeProviderAppComposition<P extends DatabaseProvider>(
  input: ProviderAppOwnerInput<P>,
): ProviderAppComposition<P> {
  const {
    core,
    repository,
    resourceCatalog: resourceCatalogModules,
    observation,
    memory,
    taskExecution: taskExecutionProvider,
    scheduledTasks,
    integration: integrationModules,
    fusion,
    digitalEmployee: digitalEmployeeModules,
    developmentAutomation,
    intent,
  } = input.modules
  const identityAccess = core.identityAccess
  const { applicationConfiguration, integrationIdentityAccess, portArtifacts } = input
  const configuration = applicationConfiguration.queries
  const { narrativeSystemAgentBinding, runtimeManagement, mcpRuntimeTests } = observation
  const {
    agentCatalog,
    skillCatalog,
    workflowCatalog,
    agentResourceIntegrity,
    mcpCatalog,
    mcpProbeStore,
    pluginCatalog,
    workgroupCatalog,
    digitalEmployeeAgentTemplates,
    capabilityTemplateOperations,
    capabilityTemplateAcl,
    developmentConfigOperations: developmentConfig,
    developmentAclRoutes,
  } = resourceCatalogModules
  const { repositoryTransport, codeHostConnections } = repository
  const { memoryOperations, memoryCatalog } = memory
  const boundCollaborationContext = taskExecutionProvider.collaboration
  const validationContext = taskExecutionProvider.validationContext
  const { scheduledTaskRuntime } = scheduledTasks
  const {
    webhookTerminalControl,
    webhookDispatcher,
    webhookDeliveryRuntime,
    webhookTriggerService,
    eventCenter,
  } = integrationModules
  const { fusionOperations } = fusion
  const digitalEmployee = digitalEmployeeModules.module
  const executionContracts = digitalEmployeeModules.executionContracts
  const developmentActivityOperations = digitalEmployeeModules.activityOperations
  const digitalEmployeePersistence = digitalEmployeeModules.routePersistence
  const developmentMissions = developmentAutomation.missionOperations
  const intentRoutes = intent.routes
  const resourcePackageBinding = composeResourcePackageBinding(input)
  const authorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
  const oidcIdentities = composeOidcIdentityOperations({
    db: input.db,
    identityAccess,
  })
  const oidcProviders = createOidcProvidersService({
    db: input.db,
    secretBox: input.secretBox,
  })
  const identityUserOperations = composeIdentityUserOperations({
    identityAccess,
    auth: core.authRuntime,
    afterDisabled: async () => await mcpRuntimeTests.reconcileDurableIntents(),
  })

  const codeHistoryQueries = composeCodeHistoryQueries(input.db)
  const codeWorkspace = composeLegacyCodeReadProviders(input.db).workspace
  const collaborationTaskAccess = createCollaborationTaskAccessPort(input.db)
  const taskRoutes = Object.freeze({
    configuration,
    operations: taskExecutionProvider.routes.tasks,
    workspaceQueries: composeTaskWorkspaceQueries({
      load: taskExecutionProvider.routes.tasks.get,
      contentScope: (workspaceRef) =>
        createWorkspaceContentScope(workspaceRef, input.selections?.workspaceContent),
    }),
    taskExecutionReadModels: taskExecutionProvider.readModels,
    runtimeInventoryContent: composeTaskRuntimeInventoryContent(
      input.selections?.runtimeInventoryContent,
    ),
    taskRecoveryOperations: taskExecutionProvider.recovery,
    codeWorkspace,
    // RFC-370 §10 V16: hosted reads answer from the task volume and persist as
    // object publications; standalone PostgreSQL keeps native worktrees and files.
    codeReview: Object.freeze({
      content:
        input.selections?.repositoryRevisionContent ?? composeLocalRepositoryRevisionContent(),
      artifacts: input.selections?.codeReviewArtifacts ?? composeLocalCodeReviewArtifacts(),
    }),
    repositoryWorkspace: core.repositoryWorkspaceStore,
    changeNarrative: Object.freeze({
      async requireMember(actor: Actor, taskId: string) {
        const access = await resolveCollaborationTaskAccess(boundCollaborationContext, {
          actor,
          taskId,
        })
        if (access.task === null) {
          throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        }
        if (access.actorRole === null) {
          throw new ForbiddenError(
            'not-task-member',
            'only task members or an actor with the required global task authority can do this',
          )
        }
      },
      resolveRuntime: ({
        runtimeName,
        defaultRuntime,
      }: {
        readonly runtimeName: string | null
        readonly defaultRuntime: string | null
      }) =>
        core.runtimeRegistry
          .resolveRuntimeByName(runtimeName ?? defaultRuntime)
          .then(narrativeSystemAgentBinding.bindRuntime),
      systemAgents: narrativeSystemAgentBinding.family,
    }),
  })
  const worktreeFiles = Object.freeze({
    store: core.repositoryWorkspaceStore,
    canViewTask: async (actor: Actor, task: { readonly id: string }) =>
      (await collaborationTaskAccess.resolveTask(actor, task.id)).visible,
    // RFC-370 §10 V15: the same content the task workspace queries read.
    content: (workspaceRef: string) =>
      input.selections?.workspaceContent?.bind(workspaceRef) ??
      createFileWorkspaceContentEffects(workspaceRef),
  })
  const collaborationRouteOperations = composeCollaborationRouteOperations({
    followupGenerator: composeClarifyFollowupGenerator({
      db: input.db,
      registry: core.runtimeRegistry,
      binding: narrativeSystemAgentBinding,
    }),
    db: input.db,
    context: boundCollaborationContext,
  })
  const workgroupTaskRoom = composeWorkgroupTaskRoom({
    db: input.db,
    taskParticipantFactory: taskExecutionProvider.workgroupTaskRoom,
    activeUsers: composeWorkgroupTaskRoomActiveUsers({
      userDirectory: identityAccess.userDirectory,
    }),
    dynamicWorkflow: composeWorkgroupTaskRoomDynamicWorkflow({
      validationContext,
      workflows: workflowCatalog.operations.create,
    }),
    systemUserId: SYSTEM_USER_ID,
    continuation: taskExecutionProvider.roomContinuation,
    broadcast(taskId, event) {
      taskBroadcaster.broadcast(TASK_CHANNEL(taskId), { id: -1, ...event })
    },
  })

  const integrationRoutes: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['integration'] = Object.freeze({
    scheduledTasks: Object.freeze({
      identityAccess: integrationIdentityAccess,
      scheduledTaskRuntime,
      buildScheduleLaunch:
        input.testSeams?.buildScheduleLaunch ?? taskExecutionProvider.trigger.buildScheduleLaunch,
      getDefaultRuntime: async () => (await configuration.read()).defaultRuntime ?? null,
    }),
    webhookEndpoints: Object.freeze({
      webhookEndpointService: integrationModules.webhookEndpointService,
    }),
    eventCenter,
    webhookTriggers: Object.freeze({
      deps: Object.freeze({ webhookTriggerService }),
      identityAccess: integrationIdentityAccess,
    }),
    webhookDeliveries: Object.freeze({
      webhookDeliveryRuntime,
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher,
      webhookTerminalControl,
    }),
  })

  const digitalDevelopmentRoutes: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['digitalDevelopment'] = Object.freeze({
    executionContracts,
    digitalEmployees: Object.freeze({
      persistence: digitalEmployeePersistence,
      module: digitalEmployee,
      activityOperations: developmentActivityOperations,
      contexts: identityAccess.directAuthority,
      graph: digitalEmployeeModules.graph,
    }),
    developmentConfig: Object.freeze({
      aclRoutes: developmentAclRoutes,
      operations: developmentConfig,
      contexts: identityAccess.directAuthority,
    }),
    developmentMissions: Object.freeze({
      operations: developmentMissions,
      contexts: identityAccess.directAuthority,
    }),
    missionInputUploads: developmentAutomation.missionInputUploads,
  })

  const taskCatalog = composeTaskCatalog({
    sources: [...taskExecutionProvider.catalogSources, digitalEmployeeModules.taskCatalogSource],
  })
  const publicRoutes: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>['public'] =
    Object.freeze({
      health: Object.freeze({
        deps: Object.freeze({
          opencodeVersion: input.opencodeVersion,
          dbVersion: input.dbVersion,
        }),
        identityAccess: identityAccess.diagnostics,
        database: core.healthDatabase,
      }),
      documentation: Object.freeze({ configuration }),
      webhookIngress: composeWebhookIngressTransport({
        crewStationEvents: integrationModules.crewStationEvents,
        webhookIngressPersistence: integrationModules.webhookIngressPersistence,
        secretBox: input.secretBox,
        digitalEmployeeEventCenter: eventCenter,
        webhookDispatcher,
        webhookTerminalControl,
      }),
    })

  // One overview projection binds the session-owned domain queries.
  const overviewQuery: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['platform']['overview']['query'] = composeSystemOverviewQuery({
    resourceCatalog: composeResourceCatalogOverviewQuery(input.db),
    repositories: core.repositoryWorkspaceOperations.overviewQueries,
    integration: scheduledTaskRuntime.overview,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.overview,
  })
  const platformRoutes: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>['platform'] =
    Object.freeze({
      observability: composeRunObservation({
        db: input.db,
        tasks: createTaskObservationFacts(input.db),
        runtimes: runtimeManagement.observations,
      }),
      config: Object.freeze({
        configuration: applicationConfiguration.composeCommands({
          runtimeRegistry:
            runtimeManagement.configuration satisfies RuntimeProfileConfigurationCommands,
          withRuntimeProbeConfigFence: composeRuntimeProbeConfigFence(
            applicationConfiguration.notificationKey,
          ),
          runtimeTests: mcpRuntimeTests.reconciliation,
          concurrencyHotApply: composeConfigConcurrencyHotApply(
            taskExecutionProvider.processConcurrencyScope,
          ),
        }),
      }),
      maintenance: Object.freeze({
        configuration,
        maintenanceStatus: input.maintenanceStatus,
        databaseTelemetry: input.databaseTelemetry,
      }),
      daemon: Object.freeze({
        runtime: selectDaemonRuntimeQueries(input.daemonRuntime, {
          infoPath: input.daemonInfoPath,
        }),
      }),
      plantuml: Object.freeze({ configuration }),
      runtime: runtimeManagement.models,
      runtimes: runtimeManagement.runtimes,
      overview: Object.freeze({
        authorization: Object.freeze({ directAuthority: identityAccess.directAuthority }),
        query: overviewQuery,
      }),
    })

  const resourceCatalogRoutes: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['resourceCatalog'] = Object.freeze({
    agents: Object.freeze({
      ...agentCatalog,
      authorityFor,
      listDigitalEmployeeTemplates: () =>
        listDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates),
      taskLaunch: taskExecutionProvider.routeLaunch.agent,
    }),
    mcps: Object.freeze({
      queries: mcpCatalog.queries,
      operations: mcpCatalog.operations,
      aclIdentity: mcpCatalog.participants.aclIdentity,
      probeStore: mcpProbeStore,
      authorityFor,
      runtimeTests: { commands: mcpRuntimeTests.commands, queries: mcpRuntimeTests.queries },
      runtimeTestCommandContextFor: mcpRuntimeTests.contexts.command,
      runtimeTestQueryContextFor: mcpRuntimeTests.contexts.query,
      probeRunner: mcpRuntimeTests.probeRunner,
    }),
    plugins: Object.freeze({
      queries: pluginCatalog.queries,
      operations: pluginCatalog.operations,
      authorityFor,
    }),
    skills: Object.freeze({ ...skillCatalog, authorityFor }),
    repositories: Object.freeze({
      store: core.repositoryWorkspaceStore,
      cached: Object.freeze({
        configuration,
        appHome: input.appHome,
        secretBox: input.secretBox,
      }),
      groups: Object.freeze({ configuration }),
      mirrors: composeRepositoryMirrors({
        store: core.repositoryWorkspaceStore,
        secretBox: input.secretBox,
        appHome: input.appHome,
        ...(input.selections?.repositoryRemote === undefined
          ? {}
          : { remote: input.selections?.repositoryRemote }),
      }),
    }),
    workflows: Object.freeze({
      runtime: input.testSeams?.workflowRuntime ?? Object.freeze({}),
      module: Object.freeze({ ...workflowCatalog, authorityFor }),
    }),
    workgroups: Object.freeze({
      queries: workgroupCatalog.queries,
      operations: workgroupCatalog.operations,
      resourceIntegrityQueries: agentResourceIntegrity.queries,
      authorityFor,
      taskLaunch: taskExecutionProvider.routeLaunch.workgroup,
    }),
    resourcePackages: Object.freeze({
      catalog: resourcePackageBinding.catalog,
      commandContextFor: resourcePackageBinding.commandContextFor,
      queryContextFor(actor: Actor) {
        return identityAccess.contexts.queryFromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actor),
          'http',
        )
      },
    }),
    workgroupTasks: Object.freeze({ module: workgroupTaskRoom, authorityFor }),
  })

  const taskExecutionRoutes: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['taskExecution'] = Object.freeze({
    tasks: taskRoutes,
    catalog: taskCatalog,
    archive: Object.freeze({
      configuration,
      taskArchiveMaintenance: taskExecutionProvider.archive,
    }),
    portArtifacts: Object.freeze({
      taskExecutionReadModels: taskExecutionProvider.readModels,
      portArtifacts,
    }),
    clarifyDirective: Object.freeze({
      operations: taskExecutionProvider.routes.clarifyDirective,
    }),
    feedback: Object.freeze({
      collaborationContext: boundCollaborationContext,
      memoryOperations,
    }),
  })

  const sourceControlRoutes: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['sourceControl'] = Object.freeze({
    codeHosts: Object.freeze({
      deps: input.testSeams?.codeHostRuntime ?? Object.freeze({}),
      service: codeHostConnections,
    }),
    repositoryTransportCredentials: Object.freeze({
      runtime: input.testSeams?.codeHostRuntime ?? Object.freeze({}),
      route: Object.freeze({
        credentials: repositoryTransport.ownCredentials,
        currentSubjects: identityAccess.resolveAuthority,
      }),
    }),
    worktreeFiles,
  })

  const codeRoutes: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>['code'] =
    Object.freeze({
      history: codeHistoryQueries,
      capabilityTemplates: Object.freeze({
        codeHistoryQueries,
        capabilityTemplates: capabilityTemplateOperations,
        capabilityTemplateAcl,
      }),
    })

  const collaborationRoutes: ProviderAppCompositionInput<
    SelectedDaemonProviderCore<P>
  >['collaboration'] = Object.freeze({
    operations: collaborationRouteOperations,
    appHome: input.appHome,
  })

  const memoryRoutes: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>['memory'] =
    Object.freeze({
      fusion: Object.freeze({
        operations: fusionOperations,
        directAuthority: identityAccess.directAuthority,
      }),
      // RFC-353 T9：技能来源追溯——版本流水来自 resource-catalog，融合记录来自 memory，
      // 拼装归 knowledge-evolution，所以路由挂在 KE 的 inbound 上。
      skillProvenance: Object.freeze({
        skills: skillCatalog.queries,
        versions: skillCatalog.versionQueries,
        authorityFor: (actor: Actor) =>
          directOperationAuthority(identityAccess.directAuthority, actor),
        memoryAuthorityFor: (actor: Actor) => ({
          actor,
          authority: directRequestAuthority(identityAccess.directAuthority, actor),
        }),
        listFusedInto: (skillId: string) => memoryCatalog.queries.listFusedInto(skillId),
        filterVisibleMemories: (
          authority: Parameters<
            ProviderMemoryRouteComposition['skillProvenance']['filterVisibleMemories']
          >[0],
          rows: Parameters<
            ProviderMemoryRouteComposition['skillProvenance']['filterVisibleMemories']
          >[1],
        ) => memoryCatalog.queries.filterVisible(authority, rows),
      }),
      memories: Object.freeze({
        catalog: memoryCatalog,
        identityAccess: Object.freeze({
          contexts: identityAccess.contexts,
          directAuthority: identityAccess.directAuthority,
        }),
      }),
      distillJobs: Object.freeze({
        memoryDistillCommands: memoryOperations.distillCommands,
        memoryDistillQueries: memoryOperations.distillQueries,
      }),
    })

  const identityRoutes: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>['identity'] =
    Object.freeze({
      auth: Object.freeze({
        deps: Object.freeze({ configuration }),
        identityAccess,
        bindings: Object.freeze({
          auth: core.authRuntime,
          listIdentitiesForUser: (userId: string) => oidcIdentities.listIdentitiesForUser(userId),
          listTokenAuditForUser: (userId: string) => core.tokenCallAudit.listForUser(userId),
        }),
      }),
      oidcAuth: Object.freeze({
        deps: Object.freeze({ configuration }),
        bindings: Object.freeze({
          auth: core.authRuntime,
          providers: oidcProviders,
          identities: oidcIdentities,
        }),
      }),
      oidc: Object.freeze({ auth: core.authRuntime, providers: oidcProviders }),
      users: Object.freeze({
        auth: Object.freeze({
          auth: core.authRuntime,
          listTokenAudit: () => core.tokenCallAudit.list(),
        }),
        identityAccess: Object.freeze({
          contexts: identityAccess.contexts,
          directAuthority: identityAccess.directAuthority,
          operations: identityUserOperations,
        }),
      }),
    })

  const systemRoutes: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>['system'] =
    Object.freeze({
      maintenanceDisk: core.maintenanceDisk,
      backup: Object.freeze({ operations: core.systemOperations, identityAccess }),
      restore: Object.freeze({ operations: core.systemOperations, identityAccess }),
      databaseMigration: Object.freeze({
        operations: input.databaseMigration.operations,
        identityAccess,
      }),
    })

  const composition: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>> = Object.freeze({
    token: input.token,
    configuration,
    authentication: core.httpAuthentication,
    core,
    public: publicRoutes,
    platform: platformRoutes,
    resourceCatalog: resourceCatalogRoutes,
    taskExecution: taskExecutionRoutes,
    integration: integrationRoutes,
    sourceControl: sourceControlRoutes,
    code: codeRoutes,
    digitalDevelopment: digitalDevelopmentRoutes,
    collaboration: collaborationRoutes,
    memory: memoryRoutes,
    intent: intentRoutes,
    identity: identityRoutes,
    system: systemRoutes,
    executionAuthority: input.executionAuthority,
  })
  return Object.freeze({
    composition,
    resourcePackageApplyActivity: resourcePackageBinding.applyActivity,
  })
}

/** Resource-package authority, catalog and atomic apply share one session binding. */
function composeResourcePackageBinding<P extends DatabaseProvider>(
  input: ProviderAppOwnerInput<P>,
) {
  const packageActorsByAuthority = new WeakMap<object, Actor>()
  const box = input.secretBox
  const identityAccess = input.modules.core.identityAccess
  const resourceCatalogModules = input.modules.resourceCatalog
  const provider = composePostgresqlResourcePackageProvider({
    db: input.db,
    appHome: input.appHome,
    authorityResolver: {
      resolve(authority) {
        const actor = packageActorsByAuthority.get(authority)
        if (actor === undefined) throw new Error('foreign-resource-package-authority')
        return actor
      },
    },
    mcpLifecycle: resourceCatalogModules.mcpTransactionLifecycle,
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({
      db: input.db,
    }),
    skillArtifacts: input.selections?.resourcePackageSkillArtifacts,
    skillPackageContent: input.selections?.resourcePackageSkillContent,
    ...(input.selections?.resourcePackagePluginArtifacts === undefined
      ? { pluginInstaller: createResourcePackagePluginInstaller() }
      : { pluginArtifacts: input.selections?.resourcePackagePluginArtifacts }),
  })
  const atomicApply = createResourcePackageAtomicApplyOperations({
    db: input.db,
    box,
  })
  return Object.freeze({
    applyActivity: atomicApply,
    catalog: composePostgresqlResourcePackageCatalog({
      provider,
      execution: createPostgresqlResourcePackageExecutionAdapter({
        box,
        provider,
        atomicApply,
      }),
    }),
    commandContextFor(actor: Actor): CommandContext {
      const context = identityAccess.contexts.fromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      packageActorsByAuthority.set(context.authority, actor)
      return context
    },
  })
}

function composeConfigConcurrencyHotApply(daemonScope: object): ConfigConcurrencyHotApplyCommand {
  return Object.freeze({
    apply(input: Parameters<ConfigConcurrencyHotApplyCommand['apply']>[0]) {
      resizeAllNodePools(daemonScope, {
        agent: input.maxConcurrentNodes,
        script: input.maxConcurrentScriptNodes,
        'code-host': input.maxConcurrentCodeHostCalls,
      })
      resizeAllTaskFanoutSems(input.multiProcessSubprocessConcurrency)
      setChildTaskBudgetCapacity(input.maxActiveChildTasks)
    },
  })
}
export interface ProviderAppComposition<P extends DatabaseProvider> {
  readonly composition: ProviderAppCompositionInput<SelectedDaemonProviderCore<P>>
  readonly resourcePackageApplyActivity: ResourcePackageApplyActivityQuery
}
