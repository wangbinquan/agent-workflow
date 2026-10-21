// RFC-391 — the sole daemon session graph and lifecycle composition.
import { composeDaemonApplication } from './daemonApplication'
import { DAEMON_SESSION_ADAPTERS, type DaemonSessionAdapter } from './daemonSessionAdapters'
import type { DaemonProviderSessionComposeInput, ComposedDaemonProviderSession } from '@/cli/start'
import { createTaskExecutionShutdownController } from '@/modules/task-execution/composition'
import { composeDaemonLifecycle, type DaemonLifecycle } from '@/cli/daemonLifecycleProgram'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'

// RFC-366: the stored budget may carry only the RFC-044 pair; the resolver is the
// single place the newer per-source caps get their defaults.
import { DAEMON_SHUTDOWN_ABORT_REASON, resolveSourceContextBudget } from '@agent-workflow/shared'
import {
  type TaskExecutionBackgroundControl,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import type { createComposedApp } from '@/server'
import { reconcileRunningFusions } from '@/modules/knowledge-evolution/public/operations'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { runTaskIdleTimeoutSweep } from '@/modules/task-execution/composition/taskIdleTimeout'
import { startConfiguredSubmoduleRefreshLoop } from '@/services/submoduleRefresh'
import { materializingSpaces } from '@/services/gc'
import { startBackupScheduler } from '@/services/backupScheduler'
import { startBatchImportGc } from '@/services/repoBatchImport'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { Paths } from '@/util/paths'
import type { buildWebSocketAdapter } from '@/ws/server'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { createMaintenanceService } from '@/platform/background/maintenanceService'
import { runEventCenterCycle } from '@/modules/event-center/composition'
import { runDigitalEmployeeOsCycle } from '@/modules/digital-employee/composition'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/composition/committedEvents'
import {
  combineCommittedEventCodecRegistries,
  createCommittedEventDispatcher,
} from '@/platform/events/committed/dispatcherWorker'
import {
  createCollaborationDurableConsumerDefinitions,
  createCollaborationWsProjector,
  createCollaborationCommittedEventProjection,
  collaborationCommittedEventCodec,
  createHumanGateContinuationWorkerDefinition,
} from '@/modules/collaboration/composition/committedEvents'
import { createAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { createCommittedEventProjectionLedger } from '@/platform/events/committed/types'
import {
  createCommittedEventDispatcherWorkerDefinition,
  startManagedWorkerDefinition,
} from '@/platform/events/committed/workerDefinitions'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { notifyChildBudgetTaskStatus } from '@/services/execution/childBudget'
import { notifyTaskTerminal } from '@/services/execution/executionWatch'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import {
  createDaemonProviderRuntimeSession,
  type DaemonProviderCloseParticipant,
  type DaemonProviderRuntimeAdmission,
  type DaemonProviderRuntimeHandleFactory,
} from '@/cli/daemonProviderRuntimeSession'
import {
  createLazyPausableDaemonRuntimeServiceBindings,
  createManagedWorkerRuntimeHandleFactory,
  createPollingDaemonRuntimeHandleFactory,
  createSignalledDaemonRuntimeHandleFactory,
} from '@/cli/daemonProviderRuntimeHandles'
import { MAINTENANCE_WORKER_ENTRY } from '@/bootstrap/maintenanceWorkerEntries'
import { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import {
  createHumanGateContinuationRecoveryQueries,
  createHumanGateTerminalSweepCommand,
} from '@/modules/collaboration/composition'
import { enforceLimits } from '@/services/limits'

interface DaemonProviderHttpAdmission {
  readonly lifecycle: Pick<
    DaemonProviderRuntimeAdmission,
    'closeWriterAdmission' | 'openWriterAdmission'
  >
  readonly run: (request: Request, next: () => Promise<Response>) => Promise<Response>
}

function isProviderControlRequest(request: Request): boolean {
  const path = new URL(request.url).pathname
  return (
    path === '/api/database' ||
    path.startsWith('/api/database/') ||
    path === '/api/health' ||
    // The endpoint an operator (and the RFC-349 evidence run) watches a
    // migration through. It reads an in-memory maintenance projection plus
    // in-memory pool telemetry — no database work of its own — so refusing it
    // only blinds the caller during the exact window it exists to describe.
    path === '/api/maintenance/status' ||
    (!path.startsWith('/api/') && !path.startsWith('/ws/'))
  )
}

/**
 * Provider-session HTTP fence. It is deliberately independent from the
 * migration state machine: the runtime session closes this gate before it
 * drains background writers and opens it only after every selected-provider
 * handle has started. Migration-control and health routes remain reachable so
 * a failed switch can report/recover without reopening business traffic.
 */
function createDaemonProviderHttpAdmission(): DaemonProviderHttpAdmission {
  let open = false
  return Object.freeze({
    lifecycle: Object.freeze({
      closeWriterAdmission() {
        open = false
      },
      openWriterAdmission() {
        open = true
      },
    }),
    async run(request: Request, next: () => Promise<Response>) {
      if (open || isProviderControlRequest(request)) return await next()
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'database-maintenance',
          message: 'database provider runtime is not accepting business requests',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
}

interface DaemonProviderRuntimeComposition {
  readonly provider: DatabaseProvider
  readonly generationId: string
  readonly app: Pick<ReturnType<typeof createComposedApp>, 'fetch'>
  readonly webSocket: ReturnType<typeof buildWebSocketAdapter>
  readonly lifecycle: DaemonLifecycle
  readonly readyOnResume?: boolean
  readonly shutdownIdentity: () => void | Promise<void>
  readonly closeProvider: () => void | Promise<void>
  /** RFC-370 v2 §3.2 — background handles start when this authority is first active. */
  readonly execution?: {
    readonly authority: Pick<ExecutionAuthorityPort, 'current' | 'whenActive'>
    readonly onActivationFailure: (error: unknown) => void
  }
}

function _bindTaskExecutionProviderBackground(
  background: TaskExecutionBackgroundControl,
  dependencies: TaskExecutionBackgroundStartDependencies,
) {
  return createLazyPausableDaemonRuntimeServiceBindings({
    runtimeId: 'task-execution',
    closeParticipantId: 'task-execution-final-close',
    service: background,
    start: () => background.start(dependencies),
  })
}

/** RFC-370 v2 §3.2 — a selected authority gates the background set; standalone has none. */
function executionActivationOf(
  input: Pick<
    DaemonProviderSessionComposeInput,
    'executionAuthority' | 'onExecutionActivationFailure'
  >,
): Pick<DaemonProviderRuntimeComposition, 'execution'> {
  if (input.executionAuthority === undefined) return {}
  const authority = input.executionAuthority
  const onActivationFailure =
    input.onExecutionActivationFailure ??
    ((error: unknown) => {
      throw error
    })
  return { execution: { authority, onActivationFailure } }
}

/** Join one provider's already-composed application and background lifetimes. */
async function _createComposedDaemonProviderRuntimeSession(
  input: DaemonProviderRuntimeComposition,
) {
  const httpAdmission = createDaemonProviderHttpAdmission()
  return await createDaemonProviderRuntimeSession({
    provider: input.provider,
    generationId: input.generationId,
    runtime: Object.freeze({
      fetch: (request: Request) =>
        httpAdmission.run(request, async () => await input.app.fetch(request)),
      tryUpgrade: input.webSocket.tryUpgrade,
      websocketHandlers: input.webSocket.handlers,
    }),
    admission: Object.freeze({
      ...httpAdmission.lifecycle,
      closeWebSocketAdmission: input.webSocket.admission.close,
      openWebSocketAdmission: input.webSocket.admission.open,
    }),
    ...input.lifecycle.sessionOptions(input.execution),
    readyOnResume: input.readyOnResume,
    shutdownIdentity: input.shutdownIdentity,
    closeProvider: input.closeProvider,
  })
}

export async function composeDaemonSession(
  composeInput: DaemonProviderSessionComposeInput,
): Promise<ComposedDaemonProviderSession> {
  const input = composeInput
  const adapter = DAEMON_SESSION_ADAPTERS[input.provider.provider] as DaemonSessionAdapter
  adapter.admitSelections(input)
  const db = adapter.open(input.provider, input.migrationsFolder)
  input.log.info('db ready', {
    provider: input.provider.provider,
    path: Paths.db,
    dbVersion: input.dbVersion,
  })
  const databaseMigration = composeDatabaseMigrationModule({
    admission: input.migrationAdmission,
    sqlitePath: Paths.db,
    operationsRoot: Paths.databaseMigrationsDir,
    generationPointerPath: Paths.databaseGenerationPointer,
    configPath: Paths.config,
    executionMode: 'background',
    onBackgroundFailure({ operationId, error }) {
      input.log.error('database migration background operation failed', {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  const application = await composeDaemonApplication(
    {
      taskDeletionEffects: input.taskDeletionEffects,
      repositoryPublicationTransport: input.repositoryPublicationTransport,
      nodeRunPromptContentEffects: input.nodeRunPromptContentEffects,
      portArtifactContentEffects: input.portArtifactContentEffects,
      runtimeInventoryContent: input.runtimeInventoryContent,
      taskRunSelection: input.taskRunSelection,
      taskRecovery: input.taskRecovery,
      taskInputFiles: input.taskInputFiles,
      repositoryPreparationEffects: input.repositoryPreparationEffects,
      scratchWorkspaceEffects: input.scratchWorkspaceEffects,
      fusionWorkspaceEffects: input.fusionWorkspaceEffects,
      workspaceMaintenanceFilesystem: input.workspaceMaintenanceFilesystem,
      workspacePresence: input.workspacePresence,
      initializeExecution: input.initializeExecution,
      recoveredExecutionTaskIds: input.recoveredExecutionTaskIds,
      systemAgentRunFamily: input.systemAgentRunFamily,
      mcpDiagnostics: input.mcpDiagnostics,
      developmentPurposes: input.developmentPurposes,
      runtimeManagement: input.runtimeManagement,
      reviewArtifacts: input.reviewArtifacts,
      reviewRollbackSnapshots: input.reviewRollbackSnapshots,
      developmentWorkspaceRepositoryPreparation: input.developmentWorkspaceRepositoryPreparation,
      workspaceExcludeProfiles: input.workspaceExcludeProfiles,
      automationWorkspaceEffects: input.automationWorkspaceEffects,
      actionWorkspaceEffects: input.actionWorkspaceEffects,
      conflictMergeWorkspaceEffects: input.conflictMergeWorkspaceEffects,
      provider: input.provider,
      db,
      config: input.config,
      runtimeLegacyConfiguration: input.runtimeLegacyConfiguration,
      log: input.log,
      dbPath: Paths.db,
      configuration: input.configuration,
      applicationConfiguration: input.applicationConfiguration,
      taskLaunchConfiguration: input.taskLaunchConfiguration,
      taskArchive: input.taskArchive,
      skillContent: input.skillContent,
      employeePrograms: input.employeePrograms,
      programFixtureProcess: input.programFixtureProcess,
      actionWorkspaceEntries: input.actionWorkspaceEntries,
      repositoryRevisionContent: input.repositoryRevisionContent,
      codeReviewArtifacts: input.codeReviewArtifacts,
      employeeInputArtifacts: input.employeeInputArtifacts,
      missionInputBlobs: input.missionInputBlobs,
      pluginInstaller: input.pluginInstaller,
      beforeEventObservationWrite: input.beforeEventObservationWrite,
      databaseBackup: input.databaseBackup,
      archivedNodeEvents: input.archivedNodeEvents,
      crewStationEvents: input.crewStationEvents,
      intentArtifacts: input.intentArtifacts,
      evidenceArtifacts: input.evidenceArtifacts,
      resourcePackageSkillArtifacts: input.resourcePackageSkillArtifacts,
      resourcePackagePluginArtifacts: input.resourcePackagePluginArtifacts,
      resourcePackageSkillContent: input.resourcePackageSkillContent,
      workspaceContent: input.workspaceContent,
      repositoryRemote: input.repositoryRemote,
      workspaceUploads: input.workspaceUploads,
      isolationWorkspaces: input.isolationWorkspaces,
      repositoryGitWorkspaces: input.repositoryGitWorkspaces,
      repositoryCandidateEffects: input.repositoryCandidateEffects,
      workspaceReads: input.workspaceReads,
      employeeCaseWorkspaceEffects: input.employeeCaseWorkspaceEffects,
      repositoryBaselines: input.repositoryBaselines,
      verificationCommands: input.verificationCommands,
      bootExecutionRecovery: input.bootExecutionRecovery,
      customObserverPrograms: input.customObserverPrograms,
      evidenceRead: input.evidenceRead,
      evidenceDocumentCommands: input.evidenceDocumentCommands,
      attemptContext: input.attemptContext,
      daemonRuntime: input.daemonRuntime,
      daemonStartupLease: input.lock,
      token: input.token,
      appHome: Paths.root,
      digitalEmployeeTypePackageDriftPolicy: input.digitalEmployeeTypePackageDriftPolicy,
      configPath: Paths.config,
      daemonInfoPath: Paths.daemonInfo,
      lockPath: Paths.lock,
      secretBox: input.secretBox,
      ...(input.executionAuthority === undefined
        ? {}
        : { executionAuthority: input.executionAuthority }),
      ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
      sourceWriteWindow: input.sourceWriteWindow,
      databaseMigration,
      dbVersion: input.dbVersion,
      maintenanceStatus: () => maintenanceService.status(),
    },
    { kind: 'daemon' },
  )
  const runtime = application.runtime
  const intentModules = runtime.intentModules
  const intentQueuedResumption = intentModules.queuedResumption

  const maintenanceConfiguration = await input.configuration.read()
  const maintenanceAdapter = adapter.maintenance({
    config: input.config,
    db,
    dbPath: Paths.db,
    migrationsFolder: input.migrationsFolder,
    generationId: input.provider.generation.payload.generationId,
  })
  const maintenanceService: ReturnType<typeof createMaintenanceService> = createMaintenanceService({
    provider: maintenanceAdapter.provider,
    fileSnapshotInFlight: maintenanceAdapter.fileSnapshotInFlight,
    openAdmissionStore: maintenanceAdapter.openAdmissionStore,
    startSupervisor: (current, handlers) =>
      startMaintenanceWorkerSupervisor({
        workerEntry: MAINTENANCE_WORKER_ENTRY,
        appHome: Paths.root,
        databaseInit: maintenanceAdapter.databaseInit(current),
        effectsBootstrap: input.maintenanceEffectsBootstrap,
        ...handlers,
      }),
    appHome: Paths.root,
    configPath: input.applicationConfiguration.notificationKey,
    loadConfig: () => maintenanceConfiguration,
    payloadSources: Object.freeze({
      activeTaskIds: () => snapshotMaintenanceTaskIds(runtime.taskExecutionModules.activeTaskIds),
      activeIntentApplyJournalIds: intentModules.maintenance.activeApplyJournalIds,
      activeResourceBundleApplyIds: runtime.resourcePackageActivity.activeApplyIds,
      bootIntentTurnIds: intentModules.maintenance.bootTurnIds,
    }),
    onLifecycleDelta(delta) {
      for (const alert of delta.alerts) {
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'lifecycle.alert',
          taskId: alert.taskId,
          rule: alert.rule,
          severity: alert.severity,
          transition: alert.transition,
        })
      }
      for (const taskId of delta.resolvedTaskIds) {
        tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
          type: 'lifecycle.alert.resolved',
          taskId,
        })
      }
    },
    onIntentQueued(sessionIds) {
      intentQueuedResumption.enqueue(sessionIds)
    },
  })

  const maintenanceBindings = createLazyPausableDaemonRuntimeServiceBindings({
    start: () => maintenanceService.start(),
    runtimeId: 'maintenance',
    closeParticipantId: 'maintenance-final-close',
    service: maintenanceService,
  })
  // RFC-370 — the service's first start recovers boot sessions, which writes.
  // Binding it lazily keeps that out of composition: a hosted standby instance
  // starts it when its activation-gated runtime handle starts, as it does for
  // every other background owner (an eager pause runs the recovery at boot and
  // fails there without the execution lease). The start runs the same
  // start → pause → resume sequence the eager binding ran, only later.
  const mcpRuntimeBindings = createLazyPausableDaemonRuntimeServiceBindings({
    runtimeId: 'mcp-runtime-tests',
    closeParticipantId: 'mcp-runtime-tests-final-close',
    start: async () => {
      await runtime.mcpRuntimeTests.pause()
      await runtime.mcpRuntimeTests.resume()
    },
    service: {
      pause: () => runtime.mcpRuntimeTests.pause(),
      resume: () => runtime.mcpRuntimeTests.resume(),
      stop: () => runtime.mcpRuntimeTests.stop(),
    },
  })
  const taskExecutionBindings = await _bindTaskExecutionProviderBackground(
    runtime.taskExecution.background,
    {
      configuration: input.configuration,
      scheduled: {
        operations: runtime.scheduledTasks.operations,
        identityAccess: runtime.scheduledTaskIdentityAccess,
      },
    },
  )

  const humanGateRecovery = createHumanGateContinuationRecoveryQueries(db)
  const humanGateWorker = createHumanGateContinuationWorkerDefinition({
    artifacts: input.humanGateArtifactRecovery,
    listPending: () => humanGateRecovery.listPending(),
    drive: runtime.driveHumanGateContinuation,
    onError(continuation) {
      input.log.warn('pending human-gate continuation drive failed', {
        taskId: continuation.taskId,
        continuationRef: continuation.continuationRef,
        error:
          continuation.error instanceof Error
            ? continuation.error.message
            : String(continuation.error),
      })
    },
  })
  const humanGateRuntimeFactory = createManagedWorkerRuntimeHandleFactory({
    id: 'human-gate-continuation',
    stopReason: 'provider-session-paused',
    start() {
      const worker = startManagedWorkerDefinition(humanGateWorker.definition, DAEMON_GENERATION)
      void worker.done.catch((error) => {
        input.log.error('human-gate continuation worker stopped unexpectedly', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return worker
    },
  })

  const committedEventCodecs = combineCommittedEventCodecRegistries(
    taskLifecycleCommittedEventCodec,
    collaborationCommittedEventCodec,
  )
  const committedEventProjectors = [
    runtime.taskExecution.lifecycleProjector,
    createCollaborationWsProjector(createCollaborationCommittedEventProjection(db)),
  ]
  const committedEventProjectionLedger = createCommittedEventProjectionLedger()
  const committedEventPersistence = createCommittedEventDeliveryPersistence(db)
  const terminalSweep = createHumanGateTerminalSweepCommand(db)
  const committedEventDispatcher = createCommittedEventDispatcher({
    persistence: committedEventPersistence,
    workerId: `committed-events-${DAEMON_GENERATION}`,
    codecs: committedEventCodecs,
    consumers: [
      ...createTaskLifecycleDurableConsumerDefinitions({
        events: runtime.eventCenter.commands,
        async closeTerminalGates(taskId, status) {
          await terminalSweep.run({ taskId, cause: `task-${status}` })
        },
        async notifyChildBudget(taskId, status) {
          notifyChildBudgetTaskStatus(runtime.taskExecution.persistence.childBudget, taskId, status)
        },
        async notifyExecutionWatch(taskId, status) {
          notifyTaskTerminal(taskId, status)
        },
        async nudgeWorkspacePrune(taskId) {
          if (runtime.taskExecutionModules.isTaskActive(taskId)) return
          await runtime.workspaceMaintenance.finalizeClaimedWorkspace(taskId)
        },
        async enqueueTaskRunDistill(taskId) {
          await runtime.memory.distillCommands.enqueue({
            sourceKind: 'task-run',
            sourceEventId: taskId,
            taskId,
          })
        },
      }),
      ...createCollaborationDurableConsumerDefinitions({
        events: runtime.eventCenter.commands,
        nudgeContinuation: humanGateWorker.nudge,
        async enqueueReviewDistill(request) {
          await runtime.memory.distillCommands.enqueue({
            sourceKind: 'review',
            sourceEventId: request.sourceEventId,
            taskId: request.taskId,
          })
        },
      }),
      ...committedEventProjectors,
    ],
    projectionLedger: committedEventProjectionLedger,
    async maxAttempts() {
      const current = await input.configuration.read()
      return 1 + current.defaultNodeRetries + current.sessionRestartBudget
    },
  })
  const committedEventWorker = createCommittedEventDispatcherWorkerDefinition({
    persistence: committedEventPersistence,
    dispatcher: committedEventDispatcher,
  })
  const committedEventRuntimeFactory = createManagedWorkerRuntimeHandleFactory({
    id: 'committed-event-dispatcher',
    stopReason: 'provider-session-paused',
    start() {
      const worker = startManagedWorkerDefinition(
        committedEventWorker.definition,
        DAEMON_GENERATION,
      )
      void worker.done.catch((error) => {
        input.log.error('committed-event dispatcher stopped unexpectedly', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return worker
    },
  })
  const committedEventPump = createAfterCommitEventPump({
    persistence: committedEventPersistence,
    codecs: committedEventCodecs,
    projectors: committedEventProjectors,
    projectionLedger: committedEventProjectionLedger,
    nudgeDispatcher: committedEventWorker.nudge,
  })
  const afterCommitPumpFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'after-commit-event-pump',
    start() {
      registerAfterCommitEventPump(committedEventPump)
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          registerAfterCommitEventPump(null)
        },
        async drain() {
          if (!stopped) throw new Error('after-commit-event-pump-drain-before-stop')
          await committedEventPump.awaitDrained()
        },
      })
    },
  })

  // RFC-366: the ONE ambient provider the distill path needs. The admission gate
  // runs inside `enqueueDistillJob`, which is reached from clarify / review /
  // feedback / the two execution-end triggers, none of which have a config path
  // to thread. Re-reading here means a settings edit gates the very next event
  // instead of the next daemon restart (D10). A broken config file falls back to
  // the defaults (manual-only, every source on) rather than silently admitting
  // everything.
  //
  // RFC-366 T6/T8 (2026-09-22): this also carries RFC-050's `memoryDistillLang`
  // as `DistillPolicy.outputLang`. It used to be a second provider with its own
  // setter and its own live configuration read, registered in the common
  // compositions — four registration sites for two knobs that are read at the
  // same instant, from the same file, by the same function. One provider now.
  const memoryDistillRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'memory-distill',
    intervalMs: 1_000,
    beforeStart: () => runtime.memory.distillWorker.recoverRunning().then(() => undefined),
    async run() {
      const current = await input.configuration.read()
      if (current.memoryDistillerEnabled === false) return
      await runtime.memory.distillWorker.tick({
        runtimeName: current.memoryDistillRuntime ?? null,
        defaultRuntime: current.defaultRuntime ?? null,
        model: current.memoryDistillModel ?? null,
        sourceContextBudget: resolveSourceContextBudget(current.memoryDistillSourceContext),
        timeoutMs: current.memoryDistillTimeoutMs,
      })
    },
    onError(error) {
      input.log.warn('memory distill tick failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const developmentWakeRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'development-wake',
    intervalMs: DAEMON_CADENCE.developmentWakeSweep,
    run: () => runtime.developmentAutomationModules.sweepWakesWhileDraining(),
    onError(error) {
      input.log.warn('development wake sweep failed', {
        err: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const employeeRuntime = runtime.digitalEmployee.runtime
  const digitalEmployeeRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'digital-employee-os',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      const result = await runDigitalEmployeeOsCycle({ runtime: employeeRuntime.worker })
      if (result.steps >= 32) {
        input.log.warn('digital employee OS reached its bounded step budget', {
          ...result,
        })
      }
    },
    onError(error) {
      input.log.warn('digital employee OS cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const eventCenterRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'event-center',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run() {
      await runtime.crewStationEvents?.runPending({
        observe: (observation) => runtime.eventCenter.commands.observe(observation),
        wakeTerminalControl: (effectId) => runtime.webhookTerminalControl.wake(effectId),
      })
      const result = await runEventCenterCycle(runtime.eventCenter.worker)
      if (result.steps >= 32) {
        input.log.warn('event center reached its bounded step budget', { ...result })
      }
    },
    onError(error) {
      input.log.warn('event center cycle failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const fusionRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'fusion-reconcile',
    intervalMs: DAEMON_CADENCE.fusionReconcile,
    run: () => reconcileRunningFusions({ operations: runtime.fusion }),
    onError() {},
  })
  const limitsRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'resource-limits',
    intervalMs: DAEMON_CADENCE.resourceLimits,
    run: () => enforceLimits(runtime.resourceLimits).then(() => undefined),
    onError(error) {
      input.log.error('resource limit enforcement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  // RFC-350: inactivity reaping remains disabled by default for both providers.
  const idleTimeoutRuntimeFactory = createPollingDaemonRuntimeHandleFactory({
    id: 'task-idle-timeout',
    intervalMs: DAEMON_CADENCE.taskIdleTimeout,
    async run() {
      await runTaskIdleTimeoutSweep(
        runtime.taskIdleTimeout,
        (await input.configuration.read()).taskIdleTimeout,
      )
    },
    onError(error) {
      input.log.error('task idle-timeout sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })

  const backupRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'scheduled-backup',
    async start() {
      const current = await input.configuration.read()
      const ticker = startBackupScheduler({
        ...adapter.scheduledBackup({
          core: application.core,
          db,
          databaseBackup: input.databaseBackup,
        }),
        intervalMs: current.backupIntervalMs,
        retentionCount: current.backupRetentionCount,
        retentionDays: current.backupRetentionDays,
        maxTotalBytes: current.backupMaxTotalBytes,
        protectedKeepCount: current.backupProtectedKeepCount,
        appHome: Paths.root,
        pruneMode: 'external',
        onBackupSettled: () => maintenanceService.runSoon('backupPrune'),
      })
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          ticker.stop()
        },
        async drain() {
          if (!stopped) throw new Error('scheduled-backup-drain-before-stop')
          await ticker.awaitIdle()
        },
      })
    },
  })
  const submoduleRefreshRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'submodule-refresh',
    async start() {
      // RFC-370 §10 V17: a hosted deployment keeps no mirror to refresh — each
      // task fetches the latest inside its own volume. The handle stays
      // registered (both daemons freeze the same writers) but runs nothing.
      if (input.repositoryRemote !== undefined)
        return Object.freeze({ stop: () => undefined, drain: async () => undefined })
      const ticker = await startConfiguredSubmoduleRefreshLoop(
        application.core.repositoryWorkspaceStore,
        input.configuration,
        undefined,
        Paths.root,
        input.secretBox,
      )
      const unregister = registerConfigAppliedListener(
        input.applicationConfiguration.notificationKey,
        () => ticker.reconfigure().then(() => undefined),
      )
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          unregister()
          ticker.stop()
        },
        async drain() {
          if (!stopped) throw new Error('submodule-refresh-drain-before-stop')
          await ticker.awaitIdle()
        },
      })
    },
  })
  const batchImportRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'batch-import-gc',
    async start() {
      const ticker = startBatchImportGc(
        undefined,
        (await input.configuration.read()).repoBatchImportRetentionMs,
      )
      let stopped = false
      return Object.freeze({
        stop() {
          if (stopped) return
          stopped = true
          ticker.stop()
        },
        drain() {
          if (!stopped) throw new Error('batch-import-gc-drain-before-stop')
        },
      })
    },
  })

  // RFC-359 W3-T14 / RFC-391: both providers retain the same close participants and order.
  const memoryDistillRecoverOnClose: DaemonProviderCloseParticipant = Object.freeze({
    id: 'memory-distill-recover-running',
    close: async () => {
      await runtime.memory.distillWorker.recoverRunning()
    },
  })
  const gracefulTaskShutdown: DaemonProviderCloseParticipant = Object.freeze({
    id: 'task-execution-graceful-shutdown',
    async close({ reason }: Parameters<DaemonProviderCloseParticipant['close']>[0]) {
      if (reason !== 'daemon-shutdown') return
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(
        {
          controller: createTaskExecutionShutdownController(runtime.taskExecution.executionModule),
          operations: runtime.taskExecution.shutdown,
          recovery: runtime.taskExecution.recovery,
        },
        0,
      )
    },
  })
  const webhookTerminalClose: DaemonProviderCloseParticipant = Object.freeze({
    id: 'webhook-terminal-control',
    close: () => runtime.webhookTerminalControl.stop(),
  })
  // RFC-349: the terminal-control worker
  // holds an interval timer plus a fire-and-forget drain bound to this
  // generation's client, so a pause has to stop it, not just a close. The close
  // participant above still runs for the retired session; `stop` is idempotent.
  const webhookTerminalRuntimeFactory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'webhook-terminal-control',
    start() {
      runtime.webhookTerminalControl.resume()
      let stopping: Promise<void> | null = null
      return Object.freeze({
        stop() {
          stopping ??= runtime.webhookTerminalControl.stop()
          return stopping
        },
        async drain() {
          if (stopping === null) throw new Error('webhook-terminal-control-drain-before-stop')
          await stopping
        },
      })
    },
  })

  const lifecycleProgram = composeDaemonLifecycle({
    provider: input.provider.provider,
    profile: input.executionAuthority?.mode,
    log: input.log,
    steps: {
      ...application.lifecycleSteps,
      'maintenance-boot-snapshot': async () => {
        await maintenanceService.captureBootSnapshot()
      },
    },
    runtimeJobs: {
      'intent-queued-resumption': intentQueuedResumption.runtimeFactory,
      'task-execution': taskExecutionBindings.runtimeFactory,
      maintenance: maintenanceBindings.runtimeFactory,
      'mcp-runtime-tests': mcpRuntimeBindings.runtimeFactory,
    },
    backgroundJobs: {
      'webhook-terminal-control': webhookTerminalRuntimeFactory,
      'after-commit-event-pump': afterCommitPumpFactory,
      'human-gate-continuation': humanGateRuntimeFactory,
      'committed-event-dispatcher': committedEventRuntimeFactory,
      'memory-distill': memoryDistillRuntimeFactory,
      'development-wake': developmentWakeRuntimeFactory,
      'digital-employee-os': digitalEmployeeRuntimeFactory,
      'event-center': eventCenterRuntimeFactory,
      'fusion-reconcile': fusionRuntimeFactory,
      'resource-limits': limitsRuntimeFactory,
      'task-idle-timeout': idleTimeoutRuntimeFactory,
      'scheduled-backup': backupRuntimeFactory,
      'submodule-refresh': submoduleRefreshRuntimeFactory,
      'batch-import-gc': batchImportRuntimeFactory,
    },
    closeParticipants: {
      'memory-distill-recover-running': memoryDistillRecoverOnClose,
      'task-execution-final-close': taskExecutionBindings.closeParticipant,
      'maintenance-final-close': maintenanceBindings.closeParticipant,
      'mcp-runtime-tests-final-close': mcpRuntimeBindings.closeParticipant,
      'task-execution-graceful-shutdown': gracefulTaskShutdown,
      'webhook-terminal-control': webhookTerminalClose,
    },
    profileJobs: (input.hostedBackgroundOwners ?? []).map((owner) =>
      createSignalledDaemonRuntimeHandleFactory(owner, DAEMON_SHUTDOWN_ABORT_REASON),
    ),
  })
  await lifecycleProgram.initialize(input.initializeExecution)
  const session = await _createComposedDaemonProviderRuntimeSession({
    provider: input.provider.provider,
    generationId: input.provider.generation.payload.generationId,
    ...executionActivationOf(input),
    app: application.app,
    webSocket: application.webSocket,
    lifecycle: lifecycleProgram,
    readyOnResume: input.lifecycle.operationId !== 'daemon-start',
    shutdownIdentity: () => application.core.identityAccess.shutdown(),
    closeProvider: () => input.provider.close(),
  })
  return Object.freeze({ application, session })
}

/** RFC-391: both providers protect live drivers and workspace materializations. */
export function snapshotMaintenanceTaskIds(activeTaskIds: () => readonly string[]): string[] {
  return [...new Set([...activeTaskIds(), ...materializingSpaces.keys()])]
}
