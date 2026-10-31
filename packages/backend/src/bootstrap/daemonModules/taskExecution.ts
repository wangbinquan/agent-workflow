import { composeRepositoryPreparationLookup } from '@/modules/source-control/composition'
import {
  composeCollaborationRepairPorts,
  composeTaskClarifyDirectiveRouteOperations,
  composeTaskReviewersPort,
  composeGateContinuationSupport,
} from '@/modules/collaboration/composition'
import type { ContentStore } from '@/platform/content/contentStore'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import { composeCrossContextClosure } from '../crossContextClosure'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { directOperationAuthority } from '@/routes/operationAuthority'
// RFC-382: one passive task-execution graph and one live configuration source per session.
import { type Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { createLogger } from '@/util/log'
import { runtimeConfigOpts } from '@/services/task'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'
import { composeTaskExecutionResourceBinding } from '@/modules/resource-catalog/composition/taskExecution'
import { composeDynamicWorkflowValidationContext } from '@/modules/resource-catalog/composition/workflowOperations'
import { composeWorkgroupTurnsOperations } from '@/modules/resource-catalog/composition/workgroupTurns'
import { composeRuntimeSelectionParticipantInTx } from '@/modules/runtime-management/composition/runtimeSelection'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import {
  createCollaborationCommandContext,
  createCollaborationRuntimeMechanics,
} from '@/modules/collaboration/composition'
import {
  createClarifyDecisionCommand,
  createQuestionDispatchCommand,
  createReviewDecisionCommand,
  createTaskDagCollaborationOperations,
} from '@/modules/collaboration/composition/decisionCommands'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import { composeTaskExecutionCatalogSources } from '@/modules/task-execution/composition/taskCatalogSources'
import {
  createTaskExecutionPersistence,
  createTaskExecutionResourceBinding,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeAgentLaunchResourceOperations } from '@/modules/task-execution/composition/agentLaunchResources'
import { composeWorkgroupLaunchResourceOperations } from '@/modules/task-execution/composition/workgroupLaunchResources'
import { composeDynamicWorkflowPersistence } from '@/modules/task-execution/composition/dynamicWorkflowPersistence'
import { composeNodeRunRuntimePersistence } from '@/modules/task-execution/composition/nodeRunRuntime'
import {
  createTaskDriveCoordinatorFactory,
  createRoomContinuation,
} from '@/modules/task-execution/composition/taskDriveLegacy'
import { composeGateContinuationPreDrive } from '@/modules/task-execution/composition/gateContinuationPreDrive'
import { composeDeferredRepositoryPreparation } from '@/modules/task-execution/composition/deferredRepositoryPreparation'
import type { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import type { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import {
  createGateContinuationDriver,
  composeWorktreeResumePreflight,
} from '@/modules/task-execution/public/participants'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import {
  composeTaskExecutionProviderRuntime,
  type TaskExecutionProviderRuntimeDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import type { TaskExecutionBinding } from '@/modules/task-execution/composition/taskExecutionBinding'
import type { DaemonProviderCore } from './providerCore'
import type { DaemonObservationModules } from './observation'
import type { DaemonResourceCatalogModules } from './resourceCatalog'
import type { DaemonRepositoryCredentials } from './repositoryCredentials'
import type { DaemonMemoryModules } from './memory'

type ProviderDependencies = TaskExecutionProviderRuntimeDependencies<CollaborationRouteContext>
type PreparationInput = Parameters<typeof composeRepositoryPreparation>[0]
type RouteInputs = ReturnType<ProviderDependencies['routes']>
type ReviewInputs = Parameters<typeof createReviewDecisionCommand>[0]

/** The graph is neutral; adapters supply only deployment lifetime/claim and process scope. */
export interface DaemonTaskExecutionAdapters<P extends DatabaseProvider = DatabaseProvider> {
  readonly provider: P
  execution(persistence: ProviderDependencies['persistence']): TaskExecutionBinding
  readonly processConcurrencyScope: object
}
export interface DaemonTaskExecutionInput<P extends DatabaseProvider = DatabaseProvider> {
  readonly content: ContentStore
  readonly historyRestrictions: HistoryRestrictionPort
  readonly db: PersistenceDb
  readonly appHome: string
  readonly configPath: string
  readonly secretBox?: SecretBox
  readonly adapters: DaemonTaskExecutionAdapters<P>
  readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly core: Pick<
    DaemonProviderCore,
    'identityAccess' | 'runtimeRegistry' | 'repositoryWorkspaceStore' | 'daemonActor'
  >
  readonly observation: Pick<
    DaemonObservationModules,
    'observationCalls' | 'workspacePresence' | 'runtimeSessionLeases'
  >
  readonly resources: Pick<
    DaemonResourceCatalogModules,
    'agentResourceIntegrity' | 'agentCatalog' | 'workflowCatalog'
  > & {
    readonly owners: Parameters<typeof composeTaskExecutionCatalogSources>[1]
  }
  readonly repository: Pick<
    DaemonRepositoryCredentials,
    'codeHostConnections' | 'repositoryPublicationTransport'
  >
  readonly memory: Pick<DaemonMemoryModules, 'memoryInjectionQueries' | 'memorySnapshots'> & {
    readonly memoryOperations: {
      readonly distillCommands: Parameters<typeof createClarifyDecisionCommand>[1]
    }
  }
  readonly selection: Required<
    Pick<ProviderDependencies['runtime'], 'taskRunBinding' | 'workspaceExcludeProfilesFor'>
  > &
    Pick<ProviderDependencies['runtime'], 'isolationWorkspaces' | 'repositoryGitWorkspaces'> & {
      readonly nodeRunPrompts: RouteInputs['nodeRunPrompts']
      readonly portArtifacts: ReturnType<typeof composePortArtifactOperations>
      readonly archive?: ProviderDependencies['archive']
      readonly workspaceReads?: ProviderDependencies['workspaceReads']
      readonly effects?: RouteInputs['effects']
      readonly archivedEvents?: RouteInputs['archivedEvents']
      readonly reviewArtifacts?: ReviewInputs['reviewArtifacts']
      readonly reviewRollbackSnapshots?: ReviewInputs['rollbackSnapshots']
      readonly workspaceUploads?: ProviderDependencies['routeLaunch']['workspaceUploads']
      readonly inputFiles?: ProviderDependencies['routeLaunch']['inputFiles']
      readonly preparationEffects?: PreparationInput['preparationEffects']
      readonly scratchEffects?: PreparationInput['scratchEffects']
      readonly recoverySelection?: ProviderDependencies['recoverySelection']
      readonly fusionWorkspaces: ProviderDependencies['fusion']['workspaces']
    }
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly alerts?: ProviderDependencies['lifecycleRepair']
  /** Module-level scheduler fixtures only. Production never substitutes its session scheduler. */
  readonly testSeams?: {
    readonly schedulerDriver?: SchedulerDriverPort
  }
}

export function composeDaemonTaskExecutionModules<P extends DatabaseProvider>(
  input: DaemonTaskExecutionInput<P>,
) {
  const {
    db,
    appHome,
    configPath,
    secretBox,
    taskLaunchConfiguration,
    selection,
    core,
    observation,
    memory,
  } = input
  const closure = composeCrossContextClosure(db)
  const log = createLogger('task')
  const resourceSnapshots = composeTaskExecutionResourceBinding(taskExecutionResourceDependencies)
  const resources = createTaskExecutionResourceBinding(db, resourceSnapshots)
  const persistence = createTaskExecutionPersistence(db, {
    content: input.content,
    historyRestrictions: input.historyRestrictions,
    humanGateOpen: closure.humanGateOpen,
    recoveryHumanGates: closure.collaborationReads.recovery,
    workspacePresence: observation.workspacePresence,
  })
  const collaboration: CollaborationRouteContext = createCollaborationCommandContext({
    content: input.content,
    historyRestrictions: input.historyRestrictions,
    db,
    taskRolePolicy: closure.taskRolePolicy,
    taskLock: closure.taskLock,
    appHome,
    taskExecutionReadModels: persistence.reads,
    reviewArtifacts: selection.reviewArtifacts,
    reviewDecisions: createReviewDecisionCommand({
      content: input.content,
      historyRestrictions: input.historyRestrictions,
      taskRolePolicy: closure.taskRolePolicy,
      taskLock: closure.taskLock,
      upstreamAgents: closure.upstreamAgents,
      db,
      appHome,
      reviewArtifacts: selection.reviewArtifacts,
      rollbackSnapshots: selection.reviewRollbackSnapshots,
    }),
    questionDispatches: createQuestionDispatchCommand(db, closure.taskLock, {
      historyRestrictions: input.historyRestrictions,
    }),
    clarifyDecisions: createClarifyDecisionCommand(
      db,
      memory.memoryOperations.distillCommands,
      closure.taskLock,
      { historyRestrictions: input.historyRestrictions },
    ),
  })
  const validationContext = composeDynamicWorkflowValidationContext(db)
  const workgroupClarify = composeWorkgroupTaskRoomClarifyParticipantFactory()
  const agentLaunchResources = Object.freeze({
    resources: composeAgentLaunchResourceOperations({ db }),
    integrity: input.resources.agentResourceIntegrity.launch,
  })
  const resourceAuthorityFor = (actor: Actor) =>
    Object.freeze({
      actor,
      authority: core.identityAccess.directAuthority.authorityForLegacyProjection(actor),
      resources,
    })
  async function runConfiguration() {
    const fresh = await taskLaunchConfiguration.start()
    return Object.freeze({
      appHome,
      configPath,
      daemonGeneration: DAEMON_GENERATION,
      ...(fresh.subagentLiveCapture === undefined
        ? {}
        : { subagentLiveCapture: fresh.subagentLiveCapture }),
      ...(fresh.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: fresh.cloneTimeoutMs }),
      ...(fresh.gitBaselineSyncWindowMs === undefined
        ? {}
        : { gitBaselineSyncWindowMs: fresh.gitBaselineSyncWindowMs }),
      ...runtimeConfigOpts({
        ...fresh,
        memoryDistillEnqueuer: memory.memoryOperations.distillCommands,
      }),
    })
  }
  const repositoryPreparationLookup = composeRepositoryPreparationLookup(db)
  const repositoryPreparation = composeRepositoryPreparation({
    taskPorts: composeSourceControlTaskPorts(db),
    db,
    appHome,
    secretBox,
    preparationEffects: selection.preparationEffects,
    scratchEffects: selection.scratchEffects,
    preparationConfiguration: {
      async read() {
        const current = await runConfiguration()
        return { cloneTimeoutMs: current.cloneTimeoutMs }
      },
    },
  })
  const coordinatorFactory = createTaskDriveCoordinatorFactory({
    runConfiguration,
    lifecycle: {
      attach: (request) => provider.driverLifecycle.attach(request),
      releaseAndFinalize: (request) => provider.driverLifecycle.releaseAndFinalize(request),
    },
    gateContinuationPreDrive: composeGateContinuationPreDrive({
      persistence,
      ...composeGateContinuationSupport({
        db,
        taskLock: closure.taskLock,
        historyRestrictions: input.historyRestrictions,
        memoryDistillEnqueuer: memory.memoryOperations.distillCommands,
      }),
    }),
    repositoryPreparation: {
      async run(context) {
        const fresh = await runConfiguration()
        return composeDeferredRepositoryPreparation({
          repositoryPreparationLookup,
          db,
          appHome,
          secretBox,
          repositoryPreparation,
          cloneTimeoutMs: fresh.cloneTimeoutMs,
          gitBaselineSyncWindowMs: fresh.gitBaselineSyncWindowMs,
        }).run(context)
      },
    },
    engine: () => provider.runtime.schedulerDriver,
    failures: persistence,
    log,
  })
  const coordinator = coordinatorFactory.session
  const provider = composeTaskExecutionProviderRuntime({
    collaborationRepair: composeCollaborationRepairPorts(db),
    db,
    historyRestrictions: input.historyRestrictions,
    archiveCollaboration: closure.collaborationReads.archive,
    clarifyNav: closure.collaborationReads.clarifyNav,
    persistence,
    execution: input.adapters.execution(persistence),
    log,
    coordinatorFactory,
    schedulerDriver: input.testSeams?.schedulerDriver,
    archive: selection.archive,
    workspaceReads: selection.workspaceReads,
    recoverySelection: selection.recoverySelection,
    runtime: {
      processConcurrencyScope: input.adapters.processConcurrencyScope,
      taskRunBinding: selection.taskRunBinding,
      workspaceExcludeProfilesFor: selection.workspaceExcludeProfilesFor,
      isolationWorkspaces: selection.isolationWorkspaces,
      repositoryGitWorkspaces: selection.repositoryGitWorkspaces,
      workspacePresence: observation.workspacePresence,
      observationInvocations: observation.observationCalls,
      memorySnapshots: memory.memorySnapshots,
      memoryInjectionQueries: memory.memoryInjectionQueries,
      runtimeSessionLeases: observation.runtimeSessionLeases,
      runtimeRegistry: core.runtimeRegistry,
      nodeRunRuntime: composeNodeRunRuntimePersistence(db, composeRuntimeSelectionParticipantInTx),
      taskDagCollaboration: createTaskDagCollaborationOperations(db),
      collaborationRuntime: createCollaborationRuntimeMechanics(db, {
        content: input.content,
        historyRestrictions: input.historyRestrictions,
        taskRolePolicy: closure.taskRolePolicy,
        taskLock: closure.taskLock,
        upstreamAgents: closure.upstreamAgents,
        reviewArtifacts: selection.reviewArtifacts,
        portArtifactReaderFor: () => selection.portArtifacts,
      }),
      workgroupTurns: composeWorkgroupTurnsOperations(
        db,
        composeWorkgroupHostLedgerParticipantFactory({ collaboration: workgroupClarify }),
        createWorkgroupClarifyAskGate(db),
      ),
      identityAccess: {
        delegatedRequests: core.identityAccess.delegatedRequests,
        taskExecutionResources: resources,
      },
      dynamicWorkflow: { persistence: composeDynamicWorkflowPersistence(db), validationContext },
      codeHostConnections: input.repository.codeHostConnections,
      repositoryPublicationTransport: input.repository.repositoryPublicationTransport,
    },
    rootResumeRuntime: async () => ({ runConfig: await runConfiguration() }),
    routeLaunch: {
      inputFiles: selection.inputFiles,
      workspaceUploads: selection.workspaceUploads,
      configPath,
      gitCommitIdentity: core.identityAccess.getUserGitCommitIdentity,
      coordinator,
      resourceAuthorityFor,
      agent: agentLaunchResources,
      workgroup: composeWorkgroupLaunchResourceOperations({
        db,
        integrity: input.resources.agentResourceIntegrity.launch,
      }),
    },
    routeWorkspace: {
      sourceContexts: core.identityAccess.taskPreparationContext,
      appHome,
      secretBox,
      repositoryPreparation,
    },
    routes: () => ({
      archivedEvents: selection.archivedEvents,
      effects: selection.effects,
      nodeRunPrompts: selection.nodeRunPrompts,
      collaboration,
      clarifyDirective: composeTaskClarifyDirectiveRouteOperations(collaboration),
      reviewers: composeTaskReviewersPort(collaboration),
      taskMembership: closure.taskMembership,
      memorySnapshots: memory.memorySnapshots,
      owners: input.resources.owners,
      appHome,
    }),
    lifecycleRepair: input.alerts ?? {},
    fusion: { workspaces: selection.fusionWorkspaces },
    workgroupTaskRoom: { collaboration: workgroupClarify },
    finalizeWorkspace: input.finalizeWorkspace,
  })
  const hostTasks = Object.freeze({
    db,
    launch: provider.routeLaunch.workflow,
    resolveActor: () => core.daemonActor('digital-employee-host-identity-not-admitted'),
    resourceAuthorityFor,
    cancelTask: (taskId: string) =>
      provider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
    readModels: provider.readModels,
    agents: Object.freeze({
      async get(id: string, errorCode = 'digital-employee-catalog-authority-not-admitted') {
        return input.resources.agentCatalog.queries.get(
          directOperationAuthority(
            core.identityAccess.directAuthority,
            await core.daemonActor(errorCode),
          ),
          { id },
        )
      },
    }),
    workflows: Object.freeze({
      async get(id: string) {
        return input.resources.workflowCatalog.queries.get(
          directOperationAuthority(
            core.identityAccess.directAuthority,
            await core.daemonActor('digital-employee-catalog-authority-not-admitted'),
          ),
          { id },
        )
      },
    }),
  })
  const gateContinuation = createGateContinuationDriver({
    isDriving: (taskId) => provider.executionModule.runtimeRegistry.hasTask(taskId),
    coordinator,
  })
  const roomContinuation = createRoomContinuation({
    assertResumable: composeWorktreeResumePreflight({
      getTask: provider.routes.tasks.get,
      taskRecoveryOperations: provider.recovery,
      worktreeExists: (reference) => observation.workspacePresence.exists(reference),
    }),
    gateContinuation,
    log,
  })
  return Object.freeze({
    ...provider,
    taskRolePolicy: closure.taskRolePolicy,
    processConcurrencyScope: input.adapters.processConcurrencyScope,
    hostTasks,
    collaboration,
    resourceSnapshots,
    resources,
    coordinator,
    coordinatorFactory,
    runConfiguration,
    validationContext,
    catalogSources: composeTaskExecutionCatalogSources(db, input.resources.owners),
    gateContinuation,
    roomContinuation,
    activeTaskIds: () =>
      provider.executionModule.runtimeRegistry.activeTokens().map((token) => token.taskId),
    isTaskActive: (taskId: string) => provider.executionModule.runtimeRegistry.hasTask(taskId),
  })
}
export type DaemonTaskExecutionModules<P extends DatabaseProvider = DatabaseProvider> = ReturnType<
  typeof composeDaemonTaskExecutionModules<P>
>
