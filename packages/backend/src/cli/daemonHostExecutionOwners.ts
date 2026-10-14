import type { composeIntentQueuedResumption } from '@/modules/intent/composition/queuedResumption'
import type { IntentTurnExecutionLifecycle } from '@/modules/intent/composition/execution'
import { resolveSourceContextBudget } from '@agent-workflow/shared'
import type { MemoryDistillWorker } from '@/modules/memory/public/commands'
import {
  IndeterminateRuntimeProcessError,
  MemoryDistillSettlementPendingError,
} from '@/modules/memory/composition'
import type { DevelopmentAutomationModule } from '@/modules/development-automation/composition'
import {
  runDigitalEmployeeOsCycle,
  type DigitalEmployeeWriterCutoverOperations,
} from '@/modules/digital-employee/composition'
import { runEventCenterCycle } from '@/modules/event-center/composition'
import { reconcileRunningFusions } from '@/modules/knowledge-evolution/public/operations'
import type { MrTerminalExecutionLifecycle } from '@/modules/integration/composition/webhookTerminalControl'
import type { SecretBox } from '@/auth/secretBox'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { ResourceLimitOperations } from '@/modules/system-operations/public/operations'
import type { TaskExecutionModule } from '@/modules/task-execution/composition'
import { ownershipTokenKey } from '@/modules/task-execution/public/participants'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/public/operations'
import {
  runTaskIdleTimeoutSweep,
  type TaskIdleTimeoutOperations,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import { startBackupScheduler, type ScheduledBackupRequester } from '@/services/backupScheduler'
import { startConfiguredSubmoduleRefreshLoop } from '@/services/submoduleRefresh'
import { startBatchImportGc } from '@/services/repoBatchImport'
import { enforceLimits } from '@/services/limits'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { createAuthorityPollingDaemonRuntimeHandleBinding } from './daemonProviderRuntimeHandles'
import { waitForExecutionActivation } from '@/platform/background/activation'
import type { McpDiagnosticsExecutionLifecycle } from '@/modules/resource-catalog/composition/mcpDiagnostics'
import type {
  AuthorityManagedWorkerDefinition,
  BackgroundExecutionLifetime,
} from '@/platform/background/definitions'
import { startAuthorityManagedWorker } from '@/platform/background/authorityManagedWorker'
import type {
  TaskExecutionBackgroundControl,
  TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import type { ColdMaintenanceService } from '@/platform/background/maintenanceService'
import type { ColdAfterCommitEventPump } from '@/platform/events/committed/afterCommitEventPump'
import {
  registerAfterCommitEventPump,
  releaseAfterCommitEventPump,
} from '@/platform/events/committed/runtime'
import type {
  DaemonProviderHostExecutionHandleBinding,
  DaemonProviderRuntimeHandle,
} from './daemonProviderRuntimeSession'

type OwnerStartInput = Parameters<DaemonProviderHostExecutionHandleBinding['start']>[0]
type OwnerAction = DaemonProviderRuntimeHandle['stop']

interface OwnerLifetime {
  readonly stop: OwnerAction
  readonly drain: OwnerAction
  readonly quiesceAuthorityLoss: OwnerAction
  readonly drainAuthorityLoss: OwnerAction
}

/** Each owner must supply both policies; there is no normal-stop loss fallback. */
function bindOwner(input: {
  readonly id: string
  readonly group: DaemonProviderHostExecutionHandleBinding['group']
  readonly start: (input: OwnerStartInput) => OwnerLifetime | Promise<OwnerLifetime>
}): DaemonProviderHostExecutionHandleBinding {
  const lifetimes = new WeakMap<
    DaemonProviderRuntimeHandle,
    {
      readonly context: OwnerStartInput['context']
      readonly quiesce: OwnerAction
      readonly drain: OwnerAction
    }
  >()
  const requireLifetime = (
    request: Parameters<DaemonProviderHostExecutionHandleBinding['quiesceAuthorityLoss']>[0],
  ) => {
    const lifetime = lifetimes.get(request.handle)
    if (lifetime === undefined || lifetime.context !== request.context) {
      throw new Error(`daemon-host-owner-lifetime-mismatch:${input.id}`)
    }
    return lifetime
  }
  return Object.freeze<DaemonProviderHostExecutionHandleBinding>({
    id: input.id,
    group: input.group,
    async start(request) {
      if (request.context.generation !== request.scope.generationId || !request.context.current()) {
        throw new Error(`daemon-host-owner-unavailable:${input.id}`)
      }
      const owner = await input.start(request)
      const handle = Object.freeze({ stop: owner.stop.bind(owner), drain: owner.drain.bind(owner) })
      lifetimes.set(handle, {
        context: request.context,
        quiesce: owner.quiesceAuthorityLoss.bind(owner),
        drain: owner.drainAuthorityLoss.bind(owner),
      })
      return handle
    },
    quiesceAuthorityLoss(request) {
      return requireLifetime(request).quiesce()
    },
    drainAuthorityLoss(request) {
      return requireLifetime(request).drain()
    },
  })
}

export function bindTaskExecutionHostOwner(input: {
  readonly background: TaskExecutionBackgroundControl
  readonly dependencies: TaskExecutionBackgroundStartDependencies
}): DaemonProviderHostExecutionHandleBinding {
  const background = input.background
  const start = background.startAuthority.bind(background)
  const dependencies = input.dependencies
  return bindOwner({
    id: 'task-execution',
    group: 'task',
    async start({ context }) {
      const lifetime = await start(dependencies, {
        current: context.current.bind(context),
        recoveryGrant: context,
        ...(context.whenActive ? { whenActive: context.whenActive } : {}),
        ...(context.reportFailure ? { reportFailure: context.reportFailure.bind(context) } : {}),
        ...(context.canDispatch ? { canDispatch: context.canDispatch.bind(context) } : {}),
      })
      return {
        stop: lifetime.pause.bind(lifetime),
        drain: lifetime.drain.bind(lifetime),
        quiesceAuthorityLoss: lifetime.quiesceAuthorityLoss.bind(lifetime),
        drainAuthorityLoss: lifetime.drain.bind(lifetime),
      }
    },
  })
}

/** Embedded HTTP owns its original request-driven Task module. It has no
 * scheduled launch, boot auto-resume or orphan sweep to add here. */
export function bindEmbeddedTaskHostOwner(input: {
  readonly module: TaskExecutionModule
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const module = input.module,
    registry = module.runtimeRegistry,
    finalizations = module.host?.finalizations
  if (!finalizations) throw new Error('embedded-host-task-write-selection-missing')
  const retry = finalizations.retryPending.bind(finalizations),
    settle = finalizations.drain.bind(finalizations),
    onError = input.onError.bind(input)
  let selected: { drained: boolean } | undefined
  return bindOwner({
    id: 'task-execution',
    group: 'task',
    start({ context }) {
      if (context.generation !== module.daemonGeneration || (selected && !selected.drained))
        throw new Error('embedded-host-task-lifetime-unavailable')
      const frame = { drained: false }
      selected = frame
      const current = context.current.bind(context)
      let quiesced = false,
        normal: Promise<void> | undefined,
        receiptTail = Promise.resolve()
      let normalTickets: Awaited<ReturnType<TaskExecutionModule['pause']>> | undefined
      // Only retry original issued result writes; this remains alive through
      // loss drain, exactly as TaskExecution's daemon result intake loop does.
      const timer = setInterval(() => {
        if (!finalizations.snapshot().length) return
        receiptTail = receiptTail.then(retry).catch(onError)
        void receiptTail.catch(() => {})
      }, 1_000)
      timer.unref?.()
      module.resume()
      const quiesce = async () => {
        quiesced = true
        await module.quiesceAuthorityLoss()
      }
      const waitRuntime = async () => {
        await module.awaitIdle()
        const tickets =
          normalTickets ??
          registry.activeTokens().map((token) => ({ token, tokenKey: ownershipTokenKey(token) }))
        const results = await Promise.all(tickets.map((ticket) => registry.awaitStopped(ticket)))
        const unknown = results.find((result) => result.kind === 'unreaped')
        if (unknown?.kind === 'unreaped')
          throw new Error(`embedded-host-task-unreaped:${unknown.code}`)
        await settle()
        await receiptTail
      }
      return {
        stop() {
          if (normal) return normal
          quiesced = true
          normal = (async () => {
            if (!normalTickets && !current()) {
              await module.quiesceAuthorityLoss()
              return
            }
            normalTickets ??= await module.pause('provider-session-paused')
            const stopped = await Promise.all(
              normalTickets.map((ticket) => registry.awaitStopped(ticket)),
            )
            if (stopped.some((result) => result.kind === 'unreaped'))
              throw new Error('embedded-host-task-normal-stop-unreaped')
          })()
          void normal.catch(() => {
            normal = undefined
          })
          return normal
        },
        async drain() {
          if (!quiesced) throw new Error('embedded-host-task-drain-before-quiesce')
          await normal
          await waitRuntime()
          clearInterval(timer)
          frame.drained = true
        },
        quiesceAuthorityLoss: quiesce,
        async drainAuthorityLoss() {
          if (!quiesced) throw new Error('embedded-host-task-drain-before-quiesce')
          await waitRuntime()
          clearInterval(timer)
          frame.drained = true
        },
      }
    },
  })
}

export function bindIntentQueuedHostOwner(
  factory: ReturnType<typeof composeIntentQueuedResumption>['runtimeFactory'],
): DaemonProviderHostExecutionHandleBinding {
  const start = factory.startAuthority.bind(factory)
  return bindOwner({
    id: 'intent-queued-resumption',
    group: 'intent',
    start({ context }) {
      const lifetime = start(context)
      // This same owner retains unadmitted IDs and drains the original actual
      // HTTP/queued/automatic turns, including their primary result ACKs.
      return {
        stop: lifetime.stop.bind(lifetime),
        drain: lifetime.drain.bind(lifetime),
        quiesceAuthorityLoss: lifetime.stop.bind(lifetime),
        drainAuthorityLoss: lifetime.drain.bind(lifetime),
      }
    },
  })
}

/** Embedded HTTP really exposes Intent turns but has no daemon boot queue. */
export function bindEmbeddedIntentHostOwner(
  execution: IntentTurnExecutionLifecycle,
): DaemonProviderHostExecutionHandleBinding {
  const start = execution.start.bind(execution)
  return bindOwner({
    id: 'intent-turn-execution',
    group: 'intent',
    start({ context }) {
      const lifetime = start(context)
      return {
        stop: lifetime.stop,
        drain: lifetime.drain,
        quiesceAuthorityLoss: lifetime.stop,
        drainAuthorityLoss: lifetime.drain,
      }
    },
  })
}

export function bindMcpDiagnosticsHostOwner(
  execution: McpDiagnosticsExecutionLifecycle,
): DaemonProviderHostExecutionHandleBinding {
  const start = execution.start.bind(execution)
  const pause = execution.pause.bind(execution)
  const quiesce = execution.quiesce.bind(execution)
  const awaitDrained = execution.awaitDrained.bind(execution)
  return bindOwner({
    id: 'mcp-runtime-tests',
    group: 'diagnostics',
    async start({ context }) {
      await start(context)
      return {
        stop: () => pause(context),
        drain: () => awaitDrained(context),
        quiesceAuthorityLoss: () => quiesce(context),
        drainAuthorityLoss: () => awaitDrained(context),
      }
    },
  })
}

export function bindWebhookTerminalHostOwner(
  execution: MrTerminalExecutionLifecycle,
): DaemonProviderHostExecutionHandleBinding {
  const start = execution.start.bind(execution),
    pause = execution.pause.bind(execution),
    quiesce = execution.quiesce.bind(execution),
    drain = execution.awaitDrained.bind(execution)
  return bindOwner({
    id: 'webhook-terminal-control',
    group: 'event-dispatch',
    async start({ context }) {
      await start(context)
      return {
        stop: () => pause(context),
        drain: () => drain(context),
        quiesceAuthorityLoss: () => quiesce(context),
        drainAuthorityLoss: () => drain(context),
      }
    },
  })
}

/** These three owners' stop methods only remove scheduling, never abort work. */
function bindSchedulingOwner(
  id: 'scheduled-backup' | 'submodule-refresh' | 'batch-import-gc',
  start: (execution: BackgroundExecutionLifetime) => Promise<{
    stop(): void
    awaitIdle(): Promise<void>
  }>,
): DaemonProviderHostExecutionHandleBinding {
  let selected: object | undefined
  return bindOwner({
    id,
    group: 'maintenance',
    async start({ context }) {
      if (selected !== undefined) throw new Error(`${id}-prior-lifetime-not-drained`)
      const frame = Object.freeze({})
      selected = frame
      const capturedCurrent = context.current.bind(context)
      const dispatch = context.canDispatch?.bind(context)
      let quiesced = false
      let constructing = true
      const execution = Object.freeze({
        current: () => !quiesced && capturedCurrent() && (constructing || (dispatch?.() ?? true)),
        whenActive: context.whenActive,
        canDispatch: () => !quiesced && capturedCurrent() && (dispatch?.() ?? true),
      })
      let ticker: Awaited<ReturnType<typeof start>> | undefined
      try {
        ticker = await start(execution)
        if (!execution.current()) throw new Error(`${id}-execution-unavailable`)
        constructing = false
      } catch (error) {
        quiesced = true
        if (ticker !== undefined) {
          ticker.stop()
          try {
            await ticker.awaitIdle()
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], `${id} start cleanup failed`)
          }
        }
        if (selected === frame) selected = undefined
        throw error
      }
      const stopTicker = ticker.stop.bind(ticker),
        awaitIdle = ticker.awaitIdle.bind(ticker)
      const stopScheduling = () => {
        quiesced = true
        stopTicker()
      }
      const drain = async () => {
        if (!quiesced) throw new Error(`${id}-drain-before-quiesce`)
        await awaitIdle()
        if (selected === frame) selected = undefined
      }
      return {
        stop: stopScheduling,
        drain,
        quiesceAuthorityLoss: stopScheduling,
        drainAuthorityLoss: drain,
      }
    },
  })
}

export function bindScheduledBackupHostOwner(input: {
  readonly configuration: ApplicationConfigurationQueries
  readonly createScheduledBackup: ScheduledBackupRequester
  readonly appHome: string
  readonly onBackupSettled: () => void
}): DaemonProviderHostExecutionHandleBinding {
  const read = input.configuration.read.bind(input.configuration),
    createScheduledBackup = input.createScheduledBackup.bind(input),
    onBackupSettled = input.onBackupSettled.bind(input),
    appHome = input.appHome
  return bindSchedulingOwner('scheduled-backup', async (execution) => {
    const config = await read()
    if (!execution.current()) throw new Error('scheduled-backup-execution-unavailable')
    return startBackupScheduler({
      createScheduledBackup,
      appHome,
      onBackupSettled,
      execution,
      pruneMode: 'external',
      intervalMs: config.backupIntervalMs,
      retentionCount: config.backupRetentionCount,
      retentionDays: config.backupRetentionDays,
      maxTotalBytes: config.backupMaxTotalBytes,
      protectedKeepCount: config.backupProtectedKeepCount,
    })
  })
}

export function bindSubmoduleRefreshHostOwner(input: {
  readonly store: RepositoryWorkspaceStore
  readonly configuration: ApplicationConfigurationQueries
  readonly notificationKey: string
  readonly appHome: string
  readonly secretBox: SecretBox
}): DaemonProviderHostExecutionHandleBinding {
  const { store, notificationKey, appHome, secretBox } = input
  const configuration = { read: input.configuration.read.bind(input.configuration) }
  return bindSchedulingOwner('submodule-refresh', async (execution) => {
    const ticker = await startConfiguredSubmoduleRefreshLoop(
      store,
      configuration,
      undefined,
      appHome,
      secretBox,
      execution,
    )
    let unregister: (() => void) | undefined
    try {
      if (!execution.current()) throw new Error('submodule-refresh-execution-unavailable')
      unregister = registerConfigAppliedListener(notificationKey, () =>
        ticker.reconfigure().then(() => undefined),
      )
      return {
        stop() {
          unregister?.()
          ticker.stop()
        },
        awaitIdle: ticker.awaitIdle.bind(ticker),
      }
    } catch (error) {
      ticker.stop()
      await ticker.awaitIdle()
      throw error
    }
  })
}

export function bindBatchImportGcHostOwner(
  configuration: ApplicationConfigurationQueries,
): DaemonProviderHostExecutionHandleBinding {
  const read = configuration.read.bind(configuration)
  return bindSchedulingOwner('batch-import-gc', async (execution) => {
    const config = await read()
    if (!execution.current()) throw new Error('batch-import-gc-execution-unavailable')
    const ticker = startBatchImportGc(
      undefined,
      config.repoBatchImportRetentionMs,
      undefined,
      execution,
    )
    // GC is a synchronous in-memory Map sweep; stopping its ticker leaves no
    // asynchronous business operation. Unlike backup/refresh there is no tail.
    return { stop: ticker.stop.bind(ticker), awaitIdle: async () => {} }
  })
}

export function bindResourceLimitsHostOwner(input: {
  readonly operations: ResourceLimitOperations
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const operations = input.operations,
    onError = input.onError.bind(input)
  return createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'resource-limits',
    group: 'maintenance',
    intervalMs: DAEMON_CADENCE.resourceLimits,
    async run({ current }) {
      await enforceLimits(operations, Date.now(), { current })
    },
    onError,
  })
}

export function bindTaskIdleTimeoutHostOwner(input: {
  readonly operations: TaskIdleTimeoutOperations
  readonly configuration: ApplicationConfigurationQueries
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const operations = input.operations,
    read = input.configuration.read.bind(input.configuration),
    onError = input.onError.bind(input)
  return createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'task-idle-timeout',
    group: 'task',
    intervalMs: DAEMON_CADENCE.taskIdleTimeout,
    async run({ current }) {
      const config = await read()
      if (!current()) return
      await runTaskIdleTimeoutSweep(operations, config.taskIdleTimeout, { execution: { current } })
    },
    onError,
  })
}

export function bindMemoryDistillHostOwner(input: {
  readonly worker: MemoryDistillWorker
  readonly configuration: ApplicationConfigurationQueries
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const tick = input.worker.tick.bind(input.worker),
    recover = input.worker.recoverRunning.bind(input.worker),
    read = input.configuration.read.bind(input.configuration),
    onError = input.onError.bind(input)
  const binding = createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'memory-distill',
    group: 'memory',
    intervalMs: 1_000,
    async beforeStart({ current }) {
      if (current()) await recover()
    },
    async run({ current }) {
      const config = await read()
      if (!current() || config.memoryDistillerEnabled === false) return
      await tick({
        execution: { current },
        runtimeName: config.memoryDistillRuntime ?? null,
        defaultRuntime: config.defaultRuntime ?? null,
        model: config.memoryDistillModel ?? null,
        sourceContextBudget: resolveSourceContextBudget(config.memoryDistillSourceContext),
        timeoutMs: config.memoryDistillTimeoutMs,
      })
    },
    onError(error) {
      if (
        error instanceof IndeterminateRuntimeProcessError ||
        error instanceof MemoryDistillSettlementPendingError
      ) {
        try {
          onError(error)
        } catch {
          /* Preserve the original unsettled owner failure. */
        }
        throw error
      }
      onError(error)
    },
  })
  const handles = new WeakMap<DaemonProviderRuntimeHandle, DaemonProviderRuntimeHandle>()
  type BlockedMemoryStart = {
    readonly context: OwnerStartInput['context']
    readonly error: IndeterminateRuntimeProcessError | MemoryDistillSettlementPendingError
    stopped: boolean
    drained: boolean
  }
  const blockedHandles = new WeakMap<DaemonProviderRuntimeHandle, BlockedMemoryStart>()
  let blockedStart: BlockedMemoryStart | undefined
  const original = (handle: DaemonProviderRuntimeHandle): DaemonProviderRuntimeHandle => {
    const found = handles.get(handle)
    if (!found) throw new Error('memory-distill-host-handle-mismatch')
    return found
  }
  const drainOriginal = async (drain: () => Promise<void>): Promise<void> => {
    try {
      await drain()
    } catch (error) {
      if (error instanceof IndeterminateRuntimeProcessError) {
        if (!error.originalRecoveryAcknowledged()) throw error
        return
      }
      if (!(error instanceof MemoryDistillSettlementPendingError)) throw error
      await error.retryOriginalSettlement()
    }
  }
  return Object.freeze({
    id: binding.id,
    group: binding.group,
    async start(input) {
      if (blockedStart && !blockedStart.drained) throw blockedStart.error
      let handle: DaemonProviderRuntimeHandle
      try {
        handle = await binding.start(input)
      } catch (error) {
        if (
          !(error instanceof IndeterminateRuntimeProcessError) &&
          !(error instanceof MemoryDistillSettlementPendingError)
        )
          throw error
        const frame: BlockedMemoryStart = {
          context: input.context,
          error,
          stopped: false,
          drained: false,
        }
        blockedStart = frame
        const blocked = Object.freeze<DaemonProviderRuntimeHandle>({
          acknowledgeStart() {
            throw frame.error
          },
          stop() {
            frame.stopped = true
          },
          async drain() {
            if (!frame.stopped) throw new Error('memory-distill-recovery-drain-before-stop')
            await drainOriginal(async () => {
              throw frame.error
            })
            frame.drained = true
          },
        })
        blockedHandles.set(blocked, frame)
        return blocked
      }
      const stop = handle.stop.bind(handle),
        drain = handle.drain.bind(handle)
      const wrapped = Object.freeze<DaemonProviderRuntimeHandle>({
        stop,
        drain: () =>
          drainOriginal(async () => {
            await drain()
          }),
      })
      handles.set(wrapped, handle)
      return wrapped
    },
    quiesceAuthorityLoss(input) {
      const blocked = blockedHandles.get(input.handle)
      if (blocked) {
        if (blocked.context !== input.context)
          throw new Error('memory-distill-host-handle-mismatch')
        blocked.stopped = true
        return
      }
      return binding.quiesceAuthorityLoss({ ...input, handle: original(input.handle) })
    },
    drainAuthorityLoss(input) {
      const blocked = blockedHandles.get(input.handle)
      if (blocked) {
        if (blocked.context !== input.context)
          throw new Error('memory-distill-host-handle-mismatch')
        return input.handle.drain()
      }
      return drainOriginal(async () => {
        await binding.drainAuthorityLoss({ ...input, handle: original(input.handle) })
      })
    },
  } satisfies DaemonProviderHostExecutionHandleBinding)
}

export function bindDevelopmentWakeHostOwner(input: {
  readonly automation: DevelopmentAutomationModule
  readonly writer: DigitalEmployeeWriterCutoverOperations
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const sweep = input.automation.sweepWakes.bind(input.automation),
    recover = input.automation.recover.bind(input.automation),
    refresh = input.writer.refresh.bind(input.writer),
    onError = input.onError.bind(input)
  return createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'development-wake',
    group: 'development',
    intervalMs: DAEMON_CADENCE.developmentWakeSweep,
    async afterActive({ current }) {
      const writer = await refresh()
      if (current() && (writer.mode === 'legacy-draining' || writer.legacyAdmissionsEnabled)) {
        try {
          await recover()
        } catch (error) {
          onError(error)
        }
      }
    },
    async run({ current }) {
      const writer = await refresh()
      if (!current() || (writer.mode === 'os-active' && !writer.legacyAdmissionsEnabled)) return
      await sweep({ current })
    },
    onError,
  })
}

export function bindDigitalEmployeeHostOwner(input: {
  readonly dependencies: Parameters<typeof runDigitalEmployeeOsCycle>[0]
  readonly prepare: () => Promise<void>
  readonly onCycle: (result: Awaited<ReturnType<typeof runDigitalEmployeeOsCycle>>) => void
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const dependencies = input.dependencies,
    prepare = input.prepare.bind(input),
    onCycle = input.onCycle.bind(input),
    onError = input.onError.bind(input)
  return createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'digital-employee-os',
    group: 'digital-employee',
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async beforeStart({ current }) {
      if (current()) await prepare()
    },
    async run({ current }) {
      onCycle(await runDigitalEmployeeOsCycle(dependencies, 32, { current }))
    },
    onError,
  })
}

export function bindEventCenterHostOwner(input: {
  readonly worker: Parameters<typeof runEventCenterCycle>[0]
  readonly onCycle: (result: Awaited<ReturnType<typeof runEventCenterCycle>>) => void
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const worker = input.worker,
    onCycle = input.onCycle.bind(input),
    onError = input.onError.bind(input)
  return createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'event-center',
    group: 'event-dispatch',
    ...(worker.waitForWake === undefined
      ? {}
      : { waitForNextRun: worker.waitForWake.bind(worker) }),
    intervalMs: DAEMON_CADENCE.digitalEmployeeOs,
    runImmediately: true,
    async run({ current }) {
      onCycle(await runEventCenterCycle(worker, 32, { current }))
    },
    onError,
  })
}

export function bindFusionReconcileHostOwner(input: {
  readonly dependencies: Parameters<typeof reconcileRunningFusions>[0]
  readonly onError: (error: unknown) => void
}): DaemonProviderHostExecutionHandleBinding {
  const dependencies = input.dependencies,
    onError = input.onError.bind(input)
  return createAuthorityPollingDaemonRuntimeHandleBinding({
    id: 'fusion-reconcile',
    group: 'knowledge',
    intervalMs: DAEMON_CADENCE.fusionReconcile,
    run: ({ current }) => reconcileRunningFusions(dependencies, { current }),
    onError,
  })
}

function bindAuthorityManagedOwner(
  id: 'human-gate-continuation' | 'committed-event-dispatcher',
  group: 'task' | 'event-dispatch',
  definition: Readonly<AuthorityManagedWorkerDefinition>,
): DaemonProviderHostExecutionHandleBinding {
  if (definition.id !== id) throw new Error(`${id}-host-worker-mismatch`)
  let selected: object | undefined
  return bindOwner({
    id,
    group,
    async start({ context, scope }) {
      if (selected !== undefined) throw new Error(`${id}-host-prior-lifetime-not-drained`)
      const frame = Object.freeze({})
      selected = frame
      let lifetime: Awaited<ReturnType<typeof startAuthorityManagedWorker>>
      try {
        lifetime = await startAuthorityManagedWorker({
          definition,
          lifetime: context,
          daemonGeneration: scope.generationId,
        })
      } catch (error) {
        if (selected === frame) selected = undefined
        throw error
      }
      const drain = async () => {
        await lifetime.drain()
        if (selected === frame) selected = undefined
      }
      return {
        stop: lifetime.stop.bind(lifetime),
        drain,
        quiesceAuthorityLoss: lifetime.quiesceAuthorityLoss.bind(lifetime),
        drainAuthorityLoss: drain,
      }
    },
  })
}

export function bindHumanGateContinuationHostOwner(
  definition: Readonly<AuthorityManagedWorkerDefinition>,
): DaemonProviderHostExecutionHandleBinding {
  return bindAuthorityManagedOwner('human-gate-continuation', 'task', definition)
}

export function bindCommittedEventHostOwner(
  definition: Readonly<AuthorityManagedWorkerDefinition>,
): DaemonProviderHostExecutionHandleBinding {
  return bindAuthorityManagedOwner('committed-event-dispatcher', 'event-dispatch', definition)
}

export function bindMaintenanceHostOwner(
  service: ColdMaintenanceService,
): DaemonProviderHostExecutionHandleBinding {
  const start = service.start.bind(service),
    pause = service.pause.bind(service),
    quiesce = service.quiesce.bind(service),
    awaitDrained = service.awaitDrained.bind(service)
  return bindOwner({
    id: 'maintenance',
    group: 'maintenance',
    async start({ context }) {
      await start(context)
      let stopped: Promise<void> | undefined
      return {
        stop() {
          if (stopped !== undefined) return stopped
          const attempt = pause()
          stopped = attempt
          void attempt.catch(() => {
            if (stopped === attempt) stopped = undefined
          })
          return attempt
        },
        drain() {
          if (stopped === undefined) throw new Error('maintenance-host-drain-before-stop')
          return stopped
        },
        quiesceAuthorityLoss: () => quiesce(context),
        drainAuthorityLoss: () => awaitDrained(context),
      }
    },
  })
}

export function bindAfterCommitHostOwner(
  pump: ColdAfterCommitEventPump,
): DaemonProviderHostExecutionHandleBinding {
  const start = pump.start.bind(pump),
    quiesce = pump.quiesce.bind(pump),
    awaitDrained = pump.awaitDrained.bind(pump)
  return bindOwner({
    id: 'after-commit-event-pump',
    group: 'event-dispatch',
    async start({ context }) {
      await start(context)
      const activation = new AbortController()
      const dispatch = context.canDispatch?.bind(context)
      const registered = context.whenActive
        ? waitForExecutionActivation(context.whenActive, activation.signal).then((active) => {
            if (active && context.current() && (dispatch?.() ?? true))
              registerAfterCommitEventPump(pump)
          })
        : Promise.resolve(registerAfterCommitEventPump(pump))
      void registered.catch(() => {})
      const stop = async () => {
        activation.abort()
        // A late old-owner stop cannot unregister a different root's pump.
        releaseAfterCommitEventPump(pump)
        await quiesce(context)
      }
      return {
        stop,
        drain: async () => {
          await registered
          await awaitDrained(context)
        },
        quiesceAuthorityLoss: stop,
        drainAuthorityLoss: async () => {
          await registered
          await awaitDrained(context)
        },
      }
    },
  })
}

/** One complete inventory, assembled only from this root's real owner objects.
 * RuntimeSession still starts them in its original provider factory order. */
export function bindDaemonHostOwners(input: {
  readonly task: Parameters<typeof bindTaskExecutionHostOwner>[0]
  readonly intent: Parameters<typeof bindIntentQueuedHostOwner>[0]
  readonly maintenance: Parameters<typeof bindMaintenanceHostOwner>[0]
  readonly mcp: Parameters<typeof bindMcpDiagnosticsHostOwner>[0]
  readonly webhook: Parameters<typeof bindWebhookTerminalHostOwner>[0]
  readonly afterCommit: Parameters<typeof bindAfterCommitHostOwner>[0]
  readonly limits: Parameters<typeof bindResourceLimitsHostOwner>[0]
  readonly idle: Parameters<typeof bindTaskIdleTimeoutHostOwner>[0]
  readonly backup: Parameters<typeof bindScheduledBackupHostOwner>[0]
  readonly submodules: Parameters<typeof bindSubmoduleRefreshHostOwner>[0]
  readonly importGc: Parameters<typeof bindBatchImportGcHostOwner>[0]
  readonly humanGate: Parameters<typeof bindHumanGateContinuationHostOwner>[0]
  readonly committed: Parameters<typeof bindCommittedEventHostOwner>[0]
  readonly memory: Parameters<typeof bindMemoryDistillHostOwner>[0]
  readonly development: Parameters<typeof bindDevelopmentWakeHostOwner>[0]
  readonly employee: Parameters<typeof bindDigitalEmployeeHostOwner>[0]
  readonly events: Parameters<typeof bindEventCenterHostOwner>[0]
  readonly fusion: Parameters<typeof bindFusionReconcileHostOwner>[0]
}): readonly DaemonProviderHostExecutionHandleBinding[] {
  return Object.freeze([
    bindIntentQueuedHostOwner(input.intent),
    bindTaskExecutionHostOwner(input.task),
    bindMaintenanceHostOwner(input.maintenance),
    bindMcpDiagnosticsHostOwner(input.mcp),
    bindWebhookTerminalHostOwner(input.webhook),
    bindAfterCommitHostOwner(input.afterCommit),
    bindResourceLimitsHostOwner(input.limits),
    bindTaskIdleTimeoutHostOwner(input.idle),
    bindScheduledBackupHostOwner(input.backup),
    bindSubmoduleRefreshHostOwner(input.submodules),
    bindBatchImportGcHostOwner(input.importGc),
    bindHumanGateContinuationHostOwner(input.humanGate),
    bindCommittedEventHostOwner(input.committed),
    bindMemoryDistillHostOwner(input.memory),
    bindDevelopmentWakeHostOwner(input.development),
    bindDigitalEmployeeHostOwner(input.employee),
    bindEventCenterHostOwner(input.events),
    bindFusionReconcileHostOwner(input.fusion),
  ])
}
